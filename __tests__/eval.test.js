// jshint esversion: 6

// Tests that focus on eval() and eval2() functionality

const {
  PyShell,
  PyRepl,
  PyScope,
  PyRuntimeError
} = require("../pyrepl/pyrepl");
let shell = undefined;
let scope = undefined;

const options = {
  codec: "bson"
};

beforeAll(async () => {
  shell = new PyRepl(options);
  scope = await shell.newScope("scopeName");
});

afterAll(async () => {
  await scope.destroy();
  await shell.exit();
});

describe("eval tests", () => {
  test("two plus two is four, return a number", async () => {
    await expect(shell.eval("2+2")).resolves.toBe(4);
    await expect(scope.eval("2+2")).resolves.toBe(4);
  });

  test("string concat, return a string", async () => {
    await expect(shell.eval("'a'+'b'+'c'")).resolves.toBe("abc");
    await expect(scope.eval("'a'+'b'+'c'")).resolves.toBe("abc");
  });

  test("float arithmetic, return number", async () => {
    await expect(shell.eval("4/5")).resolves.toBe(0.8);
    await expect(scope.eval("4/5")).resolves.toBe(0.8);
  });

  test("list returns array", async () => {
    await expect(shell.eval("[1,2,3]")).resolves.toEqual([1, 2, 3]);
    await expect(scope.eval("[1,2,3]")).resolves.toEqual([1, 2, 3]);
  });

  test("dict returns object", async () => {
    await expect(
      shell.eval('{"a": 3, "b": [0, 1], "c": { "d": {} } }')
    ).resolves.toEqual({
      a: 3,
      b: [0, 1],
      c: { d: {} }
    });
    await expect(
      scope.eval('{"a": 3, "b": [0, 1], "c": { "d": {} } }')
    ).resolves.toEqual({
      a: 3,
      b: [0, 1],
      c: { d: {} }
    });
  });

  test("undefined code throws exception", async () => {
    expect.assertions(2);

    try {
      await shell.eval("something undefined");
    } catch (e) {
      expect(e.name).toMatch("PyRuntimeError");
    }

    try {
      await scope.eval("something undefined");
    } catch (e) {
      expect(e.name).toMatch("PyRuntimeError");
    }
  });
});

describe("eval2 tests", () => {
  test("simple eval2 test", async () => {
    let x = await scope.eval2("2+3");
    expect(x).toMatchObject({
      value: 5,
      finalize: expect.any(Function)
    });
    await expect(x.finalize()).resolves.toBe(true);
  });

  test("deferred finalization", async () => {
    let x = await scope.eval2("[1, 2, 3]");
    let y = await scope.eval2(
      '{ "a": 3, "b": [ "x", 3 ], "c": {}, "d": "str" }'
    );

    expect(x).toMatchObject({
      value: [1, 2, 3],
      finalize: expect.any(Function)
    });
    expect(y).toMatchObject({
      value: {
        a: 3,
        b: ["x", 3],
        c: {},
        d: "str"
      },
      finalize: expect.any(Function)
    });

    await expect(y.finalize()).resolves.toBe(true);
    await expect(x.finalize()).resolves.toBe(true);
  });
});
