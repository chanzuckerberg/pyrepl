// jshint esversion: 6
const {
  PyShell,
  PyRepl,
  PyScope,
  PyRuntimeError
} = require("../pyrepl/pyrepl");
let shell = undefined;

beforeAll(async () => {
  shell = new PyRepl();
});

afterAll(async () => {
  await shell.exit();
});

test("scope create and destroy", async () => {
  let scope = await shell.newScope("scopeName");
  expect(scope).not.toBeNull();
  expect(scope).toBeInstanceOf(PyScope);
  await expect(scope.echo("hi")).resolves.toBe("hi");
  await expect(scope.destroy()).resolves.toBe(true);
});

test("scope maintains state", async () => {
  const pyCode = `
def myAdd(x, y):
  return x+y
`;

  let scope = await shell.newScope("Scope1");
  let scope2 = await shell.newScope("Scope2");

  // Save and then use a function
  await expect(scope.exec(pyCode)).resolves.toBe(true);
  await expect(scope.eval("myAdd(8,2)")).resolves.toBe(10);

  // Set state and then access it
  await expect(scope.exec("x = 99")).resolves.toBe(true);
  await expect(scope.eval("x")).resolves.toBe(99);

  // ensure other scopes don't contain this info.
  await expect(scope.eval('"x" in locals() or "x" in globals()')).resolves.toBe(
    true
  );
  await expect(
    scope2.eval('"x" in locals() or "x" in globals()')
  ).resolves.toBe(false);

  // clean up
  await expect(scope.destroy()).resolves.toBe(true);
});
