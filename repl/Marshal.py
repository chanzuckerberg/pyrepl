import io
import sys
import struct
import json
import bson
import numpy as np
from llist import sllist, sllistnode

""" unsupported serialization type """
class UnsupportedType(ValueError):
    pass

""" failure to deserialize """
class DecodeError(ValueError):
    pass

def py_type_name(obj):
    return type(obj).__module__ + '.' + type(obj).__name__

def ceil2N(N, x):
    K = (1<<N) - 1
    return (x + K) & ~K

class ShmemTransferBuffer:
    def __init__(self, id, mem, length, min_alloc_size = 8):
        self.id = id        # unused
        self.length = len(mem)
        self.mem = mem      # mmap object
        self.freelist = sllist()
        self.freelist.append(('f', 0, len(mem)))
        self.min_alloc_size = min_alloc_size      # 2^min_alloc_chunk

    def alloc(self, nbytes):
        """ return offset into self.mem, or None if out of space """
        # node value format: ( status, offset, length ), where
        #       status - one of 'f' or 'a'
        #       offset - byte offset in the shmem segment
        #       length - byte length
        if nbytes <= 0:
            return None
        nbytes = ceil2N(self.min_alloc_size, nbytes)
        node = self.freelist.first
        offset = None
        while node:
            chunk = node.value
            if chunk[0] is 'f' and chunk[2] >= nbytes:
                offset = chunk[1]
                node.value = ('a', offset, nbytes)
                if chunk[2] > nbytes:
                    self.freelist.insertafter(( 'f', offset+nbytes, chunk[2] - nbytes ), node)
                break
            node = node.next
        return offset

    def free(self, offset):
        """ free chunk at offset """
        # mark this chunk as free
        # XXX: should this throw if the offset is not found?
        node = self.freelist.first
        while node:
            if node.value[1] == offset:
                node.value = ('f', node.value[1], node.value[2])
                break
            node = node.next

        # coallesce all free chunks
        node = self.freelist.first
        while node:
            if node.value[0] == 'f' and node.next and node.next.value[0] == 'f':
                node.value = ('f', node.value[1], node.value[2] + node.next.value[2])
                self.freelist.remove(node.next)
                continue
            node = node.next


    # encode a numpy ndarray into the shmem transfer buffer and return descriptor.
    # If not able, return false
    #
    def encodeNumpyNdarray(self, obj):
        if self.mem and obj.nbytes <= self.length:
            offset = self.alloc(obj.nbytes)
            src = obj.reshape(-1)
            dst = np.ndarray(shape=src.shape,
                dtype=src.dtype,
                buffer=self.mem,
                offset=offset)
            np.copyto(dst, src, 'no')
            return {
                '__type__': 'shmem',
                'offset': offset,
                'nbytes': src.nbytes,
                'format': {
                    'pytype': py_type_name(obj),
                    'shape': obj.shape,
                    'order': 'C' if obj.flags['C_CONTIGUOUS'] else 'F',
                    'dtype': {
                        'type_name': obj.dtype.type.__name__,
                        'itemsize': obj.dtype.itemsize
                    }
                }
            }
        else:
            return False


# XXX: can this class be combined with encode_on_unknown to remove redundant code?
class ExtendedJSONEncoder(json.JSONEncoder):
    def __init__(self, shmem_txfr_buf = None, **kwd):
        super().__init__(**kwd)
        self.shmem_txfr_buf = shmem_txfr_buf

    def encodeNumpyNdarray(self, obj):
        val = False
        if self.shmem_txfr_buf:
            val = self.shmem_txfr_buf.encodeNumpyNdarray(obj)
        # XXX - this is almost certainly wrong!  JSON has no binary encoding,
        # so we punt and put it into a JSON array.
        return val if val else obj.tolist()

    def default(self, obj):
        tname = type(obj).__module__ + '.' + type(obj).__name__
        if tname == 'numpy.ndarray':
            return self.encodeNumpyNdarray(obj)
        else:
            return json.JSONEncoder.default(self, obj)

class Codec():
    def __init__(self, format = 'json', shmem_txfr_buf = None):
        self.shmem_txfr_buf = shmem_txfr_buf
        self.format = format

        if self.format == 'json':
            self.encode = self.encodeJSON
            self.readFrame = lambda f: f.readline()
            self.decode = self.decodeJSON
        elif format == 'bson':
            self.encode = self.encodeBSON
            self.readFrame = self.readFrameBSON
            self.decode = self.decodeBSON
        else:
            raise TypeError('Unknown codec format')

    def encodeJSON(self, obj):
        try:
            str = ExtendedJSONEncoder(shmem_txfr_buf = self.shmem_txfr_buf).encode(obj)
            str += '\n'                 # record terminator
            return str.encode()
        except TypeError as exc:
            raise UnsupportedType(str(exc)) from exc

    def encodeBSON(self, obj):
        try:
            return bson.dumps(obj, on_unknown=self.encode_on_unknown)
        except bson.UnknownSerializerError as exc:
            # no way to know which sub-element of obj tripped us up...
            raise UnsupportedType('Type not supproted by serializer') from exc

    def send(self, obj, file):
        """
        Send an object to the file.  May raise an UnsupportedType exception if there
        are python types that are not serializable.
        """
        data = self.encode(obj)
        file.buffer.write(data)
        file.flush()

    def encode_on_unknown(self, obj):
        tname = py_type_name(obj)
        if tname == 'numpy.ndarray':
            val = False
            if self.shmem_txfr_buf:
                val = self.shmem_txfr_buf.encodeNumpyNdarray(obj)
            if val:
                return val
            else:
                return {
                    '__type__': 'binary',
                    'format': {
                        'pytype': tname,
                        'shape': obj.shape,
                        'order': 'C' if obj.flags['C_CONTIGUOUS'] else 'F',
                        'dtype': {
                            'type_name': obj.dtype.type.__name__,
                            'itemsize': obj.dtype.itemsize
                        }
                    },
                    'bytes': obj.tobytes()
                }
        else:
            return obj

    def decodeJSON(self, data):
        try:
            return json.loads(data)
        except json.JSONDecodeError as exc:
            raise DecodeError(str(exc)) from exc

    def decodeBSON(self, data):
        try:
            return bson.loads(data)
        except ValueError as exc:
            raise DecodeError(str(exc)) from exc

    def _readInto(self, file, bytes_requested, buf):
        """
        read up to bytes_requested from file and put in buf
        """
        if buf is None:
            buf = io.BytesIO()
        bytes_read = 0
        while (bytes_read < bytes_requested):
            data = file.buffer.read(min(bytes_requested-bytes_read, 16*1024))
            nbytes = len(data)
            if nbytes <= 0:
                return None
            if type(data) == str:
                data = data.encode()

            bytes_read += nbytes
            buf.write(data)

        return buf

    def readFrameBSON(self, file):
        buf = io.BytesIO()
        buf = self._readInto(file, 4, buf)
        if buf is None:
            return None

        # for BSON format, see bsonspec.org
        frame_length = struct.unpack("<i", buf.getvalue())[0]
        buf = self._readInto(file, frame_length - 4, buf)
        if buf is None:
            return None
        return buf.getvalue()

    def recv(self, file):
        """
        Recv a single object from the file.  Return None on EOF
        """
        data = self.readFrame(file)
        if data:
            return self.decode(data)
        else:
            return None

    def rls_shmem(self, offset):
        self.shmem_txfr_buf.free(offset)
