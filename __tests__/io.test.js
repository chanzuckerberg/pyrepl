// jshint esversion: 6

// Tests that focus on catching IO from py code.

const {
  PyShell,
  PyRepl,
  PyScope,
  PyRuntimeError
} = require("../pyrepl/pyrepl");

test("stdio", async () => {
  let shell = new PyRepl();

  let catchError, catchMessage;
  shell.on("error", (catchError = jest.fn()));
  shell.on("message", (catchMessage = jest.fn()));

  await shell.exec('print("hello world")');
  await shell.echo("barrier");
  expect(catchMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      status: true,
      content_type: "text/plain",
      data: "hello world\n",
      pipe: "stdout"
    })
  );

  await shell.exec('print("bye now")');
  await shell.echo("barrier");
  expect(catchMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      status: true,
      content_type: "text/plain",
      data: "bye now\n",
      pipe: "stdout"
    })
  );

  await shell.exec('import sys; print("error?", file=sys.stderr)');
  await shell.echo("barrier");
  expect(catchMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      status: true,
      content_type: "text/plain",
      data: "error?\n",
      pipe: "stderr"
    })
  );

  await shell.exit();
  expect(catchMessage).toHaveBeenCalledTimes(3);
  expect(catchError).not.toHaveBeenCalled();
});
