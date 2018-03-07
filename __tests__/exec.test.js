// jshint esversion: 6

// Exec Tests

const {
  PyShell,
  PyRepl,
  PyScope,
  PyRuntimeError
} = require("../pyrepl/pyrepl");
let shell = undefined;
let scope = undefined;

beforeAll(async () => {
  shell = new PyRepl();
  scope = await shell.newScope("scopeName");
});

afterAll(async () => {
  await scope.destroy();
  await shell.exit();
});

test("simple assignment", async () => {
  await expect(shell.exec("x = 0")).resolves.toBe(true);
  await expect(scope.exec("x = 0")).resolves.toBe(true);
});

test("undefined code throws exception", async () => {
  expect.assertions(2);

  try {
    await shell.exec("something undefined");
  } catch (e) {
    expect(e.name).toMatch("PyRuntimeError");
  }

  try {
    await scope.exec("something undefined");
  } catch (e) {
    expect(e.name).toMatch("PyRuntimeError");
  }
});
