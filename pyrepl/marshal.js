// Marshaling support
// jshint esversion: 6

const fs = require("fs");
const mmap = require("mmap-io");
const BSON = require("bson");

// recursively walk object/array tree and map values
//
const revivalWalk = (obj, cb) => {
  const mapValues = (obj, cb) => {
    if (obj && typeof obj === "object") {
      for (const k in obj) {
        let v = cb(k, mapValues(obj[k], cb));
        if (v === undefined) {
          delete obj[k];
        } else {
          obj[k] = v;
        }
      }
    }
    return obj;
  };
  return cb("", mapValues(obj, cb));
};

// numpy.ndarray decoder - convert buffer to a JS approximation of an NDArray
//
const createNDArray = (shape, flatTypedArray, pos = 0) => {
  const dim = shape[0];
  const rmndr = shape.slice(1);
  if (shape.length > 1) {
    const stride = rmndr.reduce((a, b) => a * b);
    let arr = [];
    for (let i = 0; i < dim; i++) {
      arr.push(createNDArray(rmndr, flatTypedArray, pos + i * stride));
    }
    return arr;
  } else {
    return flatTypedArray.subarray(pos, pos + dim);
  }
};

const bufferToNDArray = (
  buffer,
  byteOffset,
  byteLength,
  format,
  forceCopy = false,
  options = {}
) => {
  // Int64 array not suppored as JS does not yet have a native type.
  // consider:  https://github.com/kawanet/int64-buffer
  //
  const dtype = format.dtype.type_name; // Python numpy type name
  const dtypeSize = format.dtype.itemsize;

  if (byteLength / dtypeSize !== format.shape.reduce((a, b) => a * b))
    throw new ValueError("NDArray shape and buffer length mismatch");

  // Buffer alignment for multi-byte types forced by copy.
  if (forceCopy || byteOffset % dtypeSize) {
    buffer = buffer.slice(byteOffset, byteOffset + byteLength);
    byteOffset = 0;
  }

  let typedarr;
  switch (dtype) {
    case "int8":
      typedarr = new Int8Array(buffer, byteOffset, byteLength / dtypeSize);
      break;
    case "uint8":
      typedarr = new Uint8Array(buffer, byteOffset, byteLength / dtypeSize);
      break;
    case "int16":
      typedarr = new Int16Array(buffer, byteOffset, byteLength / dtypeSize);
      break;
    case "uint16":
      typedarr = new Uint16Array(buffer, byteOffset, byteLength / dtypeSize);
      break;
    case "int32":
      typedarr = new Int32Array(buffer, byteOffset, byteLength / dtypeSize);
      break;
    case "uint32":
      typedarr = new Uint32Array(buffer, byteOffset, byteLength / dtypeSize);
      break;
    case "float32":
      typedarr = new Float32Array(buffer, byteOffset, byteLength / dtypeSize);
      break;
    case "float64":
      typedarr = new Float64Array(buffer, byteOffset, byteLength / dtypeSize);
      break;
    default:
      throw new TypeError("unsupported shared memory decoding type");
  }

  if (options.returnFlatArray) {
    // return underlying array
    return typedarr;
  } else {
    // Create correct shape
    return createNDArray(format.shape, typedarr);
  }
};

const decodeBinary = (
  buffer,
  bytesOffset,
  bytesLength,
  format,
  forceCopy = false,
  options = {}
) => {
  if (
    !(buffer instanceof ArrayBuffer) ||
    bytesOffset < 0 ||
    bytesLength > buffer.byteLength
  ) {
    throw new ValueError("unsupported buffer type - expected ArrayBuffer");
  }
  if (format.pytype === "numpy.ndarray") {
    return bufferToNDArray(
      buffer,
      bytesOffset,
      bytesLength,
      format,
      forceCopy,
      options
    );
  }
  // else
  throw new TypeError("Unsupported marshalling type");
};

class Shmem {
  constructor(sysname, size) {
    this.sysname = sysname;
    this.size = size;
    this.mem = this.mmap();
  }

  cleanup() {
    delete this.mem;
    this.mem = null;

    // Windows does not allow memory mapped files to be unlinked until
    // the process no longer has the object mapped. The mmap-io package
    // will not unmap the system object until the garbage collector is run.
    //
    // Note: electron exposes gc.  Node does not by default, so you will need
    // to run it with --expose-gc
    //
    // So...
    if (global && global.gc) {
      global.gc();
    }

    fs.existsSync(this.sysname) && fs.unlinkSync(this.sysname);
  }

  mmap() {
    try {
      // 0. if object already exists, unlink it
      fs.existsSync(this.sysname) && fs.unlinkSync(this.sysname);

      // 1. create & size file
      const fd = fs.openSync(this.sysname, "wx+");
      fs.writeSync(fd, Buffer.from([0]), 0, 1, this.size - 1);

      // 2. memory map the file
      const buf = mmap.map(this.size, mmap.PROT_READ, mmap.MAP_SHARED, fd, 0);
      fs.closeSync(fd);

      return buf.buffer; // ArrayBuffer
    } catch (e) {
      throw e;
    }
  }
}

class Codec {
  constructor(format = "json", options = {}) {
    this.format = format;
    this.options = options;

    if (this.format === "json") {
      this.encode = obj => JSON.stringify(obj).concat("\n");
      this.partialLineBuffer = {};
      this.recv = this.recvJSON;
    } else if (this.format === "bson") {
      this.bson = new BSON();
      this.encode = obj => this.bson.serialize(obj);
      this.recv = this.recvBSON;
      this.buffer = new Buffer(0);
    } else {
      throw ValueError("unsupported codec format: " + format);
    }

    this.shmem = null;
    if (options.shmemPath && options.shmemSize > 0) {
      this.shmem = new Shmem(options.shmemPath, options.shmemSize);
    }
  }

  cleanup() {
    if (this.shmem) this.shmem.cleanup();
    this.shmem = null;
  }

  // Will be called once, prior to any send/recv.
  configurePipe(pipe) {
    if (this.format === "json") {
      pipe.setEncoding("utf-8");
    }
  }

  // send a single object to the specified stream
  send(obj, file) {
    let data = this.encode(obj);
    return new Promise((resolve, reject) => {
      file.write(data, err => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  // process incoming data.  Return any newly available objects, or []
  //
  recvJSON(data, pipe) {
    let lines = data.split(/\n/g);
    let lastLine = lines.pop(); // last line is always '' or an incomplete line
    let messages = [];
    if (lines.length > 0) {
      lines[0] = (this.partialLineBuffer[pipe] || "") + lines[0];
      this.partialLineBuffer[pipe] = "";
      lines.forEach(line => {
        // XXX: needs error handling
        messages.push(JSON.parse(line));
      });
    }
    this.partialLineBuffer[pipe] = this.partialLineBuffer[pipe] + lastLine;
    return messages;
  }

  recvBSON(data, pipe) {
    // if (pipe === 'stderr') console.log(data.toString('utf-8'));
    let messages = [];
    const nbytes = this.buffer.length + data.length;
    this.buffer = Buffer.concat([this.buffer, data], nbytes);

    // XXX: Lacks even rudimentary error handling
    // See http://bsonspec.org/spec.html
    while (this.buffer.length > 4) {
      let documentLength = this.buffer.readInt32LE(0);
      if (documentLength > this.buffer.length) break;

      let document = this.buffer.slice(0, documentLength);
      this.buffer = this.buffer.slice(documentLength);

      // XXX: no error handling if this throws
      messages.push(this.bson.deserialize(document));
    }
    return messages;
  }

  // Reviver - transform objects received into native JS objects
  //

  revive(obj, options = {}) {
    const reviverFn = (options, needsFinalization, key, val) => {
      if (typeof val === "object") {
        if (val.__type__ === "binary") {
          return decodeBinary(
            val.bytes.buffer.buffer,
            val.bytes.buffer.byteOffset,
            val.bytes.buffer.byteLength,
            val.format,
            false,
            options
          );
        } else if (val.__type__ === "shmem") {
          needsFinalization.push(val);
          if (!val || val.__type__ != "shmem" || !val.format)
            throw new SyntaxError("Unable to decode - not a shmem reference");
          return decodeBinary(
            this.shmem.mem,
            val.offset,
            val.nbytes,
            val.format,
            options.copyOutOfShmem,
            options
          );
          // XXX: cleanup
          // return this.shmem.decode(val, options.copyOutOfShmem, options);
        }
      }
      return val; // default
    };

    let needsFinalization = [];
    let reviver = reviverFn.bind(this, options, needsFinalization);
    const value = revivalWalk(obj, reviver);
    return { value: value, needsFinalization: needsFinalization };
  }
}

exports.Codec = Codec;
