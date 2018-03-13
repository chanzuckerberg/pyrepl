// jshint esversion: 6
const EventEmitter = require("events");
const path = require("path");
const { spawn } = require("child_process");
const { Codec } = require("./marshal");
const uuid = require("uuid/v4");

class PyRuntimeError extends Error {
  constructor(msg) {
    // super(msg.code + ': ' + msg.details);
    super(msg.details);
    this.response = msg;
    this.code = msg.code;
    this.name = "PyRuntimeError";
    Error.captureStackTrace(this, PyRuntimeError);
  }
}

// JS client-side wrapper to send/recv JSON objects with a remote REPL
//
class PyShell extends EventEmitter {
  constructor(script, scriptArgs = [], options = {}) {
    const defaultOptions = {
      pythonPath: "python", // the python executable path
      pythonOptions: [], // options passed to Python interpreter
      verbose: false // extra logging
    };

    super();
    this.script = script;
    this.options = Object.assign({}, defaultOptions, options);

    this.tid = 1;
    this.promises = {};
    this.codec = new Codec(this.options.codec, this.options);

    const pythonPath = this.options.pythonPath;
    const args = [].concat(this.script, scriptArgs);
    this.child = spawn(pythonPath, args, options);

    ["stdout", "stderr", "stdin"].forEach(pipe => {
      this.codec.configurePipe(this.child[pipe]);
    });

    this.child.on("exit", code => {
      this.exitCode = code;
      if (this.options.verbose) console.log("pyshell: exit", code);
      this.closeIfDone();
    });
    this.child.stdout.on("end", () => {
      this.stdoutEnded = true;
      if (this.options.verbose) console.log("pyshell: stdout end");
      this.closeIfDone();
    });
    this.child.stderr.on("end", () => {
      this.stderrEnded = true;
      if (this.options.verbose) console.log("pyshell: stderr end");
      this.closeIfDone();
    });
    this.child.stdout.on("data", data => {
      this.recv(data, "stdout");
    });
    this.child.stderr.on("data", data => {
      this.recv(data, "stderr");
    });
  }

  cleanup() {
    this.codec.cleanup();
  }

  closeIfDone() {
    // Wait until we have an exit from process and all pipes are dry.
    //
    if (
      this.exitCode !== undefined &&
      this.stdoutEnded !== undefined &&
      this.stderrEnded !== undefined
    ) {
      if (this.options.verbose) console.log("pyshell: all done");

      // cancel any open promises
      for (const tid in this.promises) {
        this.promises[tid].reject("exit");
        delete this.promises[tid];
      }
      this.cleanup();
      this.emit("exit", this.exitCode);
    }
  }

  // msg format:
  //     { type: ..., tid: ..., scope: ... }
  send(msg) {
    msg.tid = uuid();
    const startTime = process.hrtime();
    const p = new Promise((resolve, reject) => {
      this.promises[msg.tid] = { resolve, reject, startTime: startTime };
    });
    return this.codec.send(msg, this.child.stdin).then(() => {
      return p;
    });
  }

  // unmarshall message and either resolve promise or emit message event
  //
  recv(data, pipe) {
    // XXX: no error handling if this throws
    let messages = this.codec.recv(data, pipe);
    // for each message, dispatch by resolving promise or emitting event
    messages.forEach(msg => {
      if (msg.type === "response" && this.promises[msg.tid]) {
        let p = this.promises[msg.tid];
        delete this.promises[msg.tid];
        if (p) {
          if (!msg.status) {
            p.reject(new PyRuntimeError(msg));
          } else {
            p.resolve(msg);
          }
          if (p.startTime) {
            let endTime = process.hrtime(p.startTime);
            let ms = 1000 * endTime[0] + endTime[1] / 1000000;
            let pyms =
              typeof msg.elapsed_time === "number"
                ? 1000.0 * msg.elapsed_time
                : -1;
            if (this.options.verbose)
              console.log(
                "%s [round trip: %f ms, %d fps] [python: %f ms]",
                msg.tid,
                ms,
                1000 / ms,
                pyms
              );
          }
        }
      } else {
        if (!msg.status) {
          this.emit("error", msg);
        } else {
          const type = msg.type || "message";
          this.emit(type, msg);
        }
      }
    });
  }
}

class PyRepl extends PyShell {
  constructor(options = {}) {
    const defaultOptions = {
      codec: "bson"
    };

    options = Object.assign({}, defaultOptions, options);

    let scriptArgs = [];
    if (options.codec === "bson") {
      scriptArgs.push("-bson");
    }
    if (options.shmemPath && options.shmemSize > 0) {
      scriptArgs.push("-mmap", options.shmemPath);
    }
    const script = path.join(__dirname, "../repl/repl.py");
    super(script, scriptArgs, options);
  }

  async newScope(name) {
    try {
      let msg = await this.send({
        type: "newScope",
        scope: "__default__",
        value: name
      });
      return new PyScope(this, name);
    } catch (e) {
      throw e;
    }
  }

  async delScope(name) {
    try {
      let msg = await this.send({
        type: "delScope",
        scope: "__default__",
        value: name
      });
      return msg.status;
    } catch (e) {
      throw e;
    }
  }

  async echo(message, scope = "__default__") {
    try {
      let msg = await this.send({
        type: "echo",
        scope: scope,
        value: message
      });
      return msg.request.value;
    } catch (e) {
      throw e;
    }
  }

  revive(value, options = {}) {
    let wrap = this.codec.revive(value, options);
    wrap.finalize = async () => {
      await Promise.all(
        wrap.needsFinalization.map(v =>
          this.send({ type: "rlsShmem", offset: v.offset })
        )
      );
      return true;
    };
    return wrap;
  }

  async eval(pyexpr, scope = "__default__", state = {}, options = {}) {
    try {
      options.copyOutOfShmem = true;
      let wrap = await this.eval2(pyexpr, scope, state, options);
      wrap.finalize();
      return wrap.value;
    } catch (e) {
      throw e;
    }
  }

  async eval2(pyexpr, scope = "__default__", state = {}, options = {}) {
    try {
      let msg = await this.send({
        type: "eval",
        scope: scope,
        code: pyexpr,
        state: state
      });
      return this.revive(msg.value, options);
    } catch (e) {
      throw e;
    }
  }

  async exec(pystmts, scope = "__default__", state = {}, options = {}) {
    try {
      let msg = await this.send({
        type: "exec",
        scope: scope,
        code: pystmts,
        state: state
      });
      return msg.status;
    } catch (e) {
      throw e;
    }
  }

  async exit() {
    // we expect this promise to be cancelled due to the pipe closing...
    try {
      let msg = await this.send({
        type: "exit"
      });
      this.cleanup();
    } catch (e) {}
    return true;
  }
}

class PyScope {
  constructor(repl, scopeName) {
    this.repl = repl;
    this.scope = scopeName;
  }

  async destroy() {
    return await this.repl.delScope(this.scope);
  }

  async echo(msg) {
    return await this.repl.echo(msg, this.scope);
  }

  revive(value, options = {}) {
    return this.repl.revive(value, options);
  }

  async eval(pyexpr, state = {}, options = {}) {
    return await this.repl.eval(pyexpr, this.scope, state, options);
  }

  async eval2(pyexpr, state = {}, options = {}) {
    return await this.repl.eval2(pyexpr, this.scope, state, options);
  }

  async exec(pystmts, state = {}, options = {}) {
    return await this.repl.exec(pystmts, this.scope, state, options);
  }
}

exports.PyShell = PyShell;
exports.PyRepl = PyRepl;
exports.PyScope = PyScope;
exports.PyRuntimeError = PyRuntimeError;
