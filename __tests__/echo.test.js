// jshint esversion: 6

// Tests that focus on setup, cleanup and the echo function.

const {
  PyShell,
  PyRepl,
  PyScope,
  PyRuntimeError
} = require("../pyrepl/pyrepl");

test("setup, echo and teardown", async () => {
  let shell = new PyRepl();

  let catchExit, catchError, catchMessage;
  shell.on("error", (catchError = jest.fn()));
  shell.on("exit", (catchExit = jest.fn()));
  shell.on("message", (catchMessage = jest.fn()));

  // would LIKE to wildcard the event consumption, but API doesn't support

  let scope = await shell.newScope("myscope");
  expect(scope).not.toBeNull();

  const msg = "Testing, 1, 2, 3";
  await expect(shell.echo(msg)).resolves.toBe(msg);
  await expect(scope.echo("hi")).resolves.toBe("hi");
  await expect(scope.destroy()).resolves.toBe(true);
  await expect(shell.exit()).resolves.toBe(true);

  expect(catchError).not.toHaveBeenCalled();
  expect(catchMessage).not.toHaveBeenCalled();
  expect(catchExit).toHaveBeenCalled();
});
