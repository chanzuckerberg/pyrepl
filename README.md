# pyrepl

A JS package providing a single-host (OS local) bridge between Node (or Electron) and a Python3 execution kernel (similar to a Jupyter kernel). Primarily built to explore ability to move data between JS and Python at high speed, using shared memory.

Experimental and a work in progress.

Relies on [`mmap-io`](https://github.com/ozra/mmap-io) for JS implementation of Posix-like mmap(2).

# Usage

```
const { PyShell, PyRepl, PyScope } = require("pyrepl/pyrepl");

async function main() {
  // the exec shell/repl
  let shell = new PyRepl();

  // create named execution scopes, which will have separate Python
  // locals()/globals().
  let scope = await shell.newScope("scopeName");

  // eval() python expressions.  Same rules as Python3 eval():
  // https://docs.python.org/3/library/functions.html#eval
  console.log("1+1 =>", await scope.eval("1+1"));

  // exec() python statements.  Same rules as Python exec():
  // https://docs.python.org/3/library/functions.html#exec
  const pyCode = `
def sum(x, y):
  return x+y
`;
  await scope.exec(pyCode);
  console.log("sum(8, 2) =>", await scope.eval("sum(8, 2)"));

  // Python exceptions become JS exceptions
  try {
    await scope.eval("1+=+1");
  } catch (e) {
    console.log("caught a Python error!");
    console.log(e.message);
  }

  // stdout and stderr are caught and become async events.
  // PyRepl is an EventEmitter
  shell.on("message", msg => {
    if (msg.type == "message" && msg.content_type == "text/plain") {
      console.log(`Python IO on ${msg.pipe}: ${msg.data}`);
    }
  });
  scope.exec('print("hello world!")');
  scope.exec('import sys; print("stderr message", file=sys.stderr)');

  // cleanup
  await scope.destroy();
  await shell.exit();
}
main();
```

See `__tests__` for more examples.

# Tests

```
npm test
```

# Good to Know / Known Issues

* Happy path known to work on Linux and Windows (if you can get mmap-io to build).
* Untested on macOS.
