// jshint esversion: 6

// Tests related to handling of ndarray (which is special)
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const each = require("jest-each");
const {
  PyShell,
  PyRepl,
  PyScope,
  PyRuntimeError
} = require("../pyrepl/pyrepl");
const pyReplTestOptions = require("./options");

let shell = undefined;
let scope = undefined;

each(pyReplTestOptions).describe(`test %s`, (testName, options) => {
  beforeAll(async () => {
    shell = new PyRepl(options);
    scope = await shell.newScope("scopeName");
  });

  afterAll(async () => {
    await scope.destroy();
    await shell.exit();
  });

  const defaultPyCode = `
import numpy as np
x = 99
a = np.arange(15, dtype=np.int32).reshape(3, 5)
b = np.arange(8, dtype=np.uint16).reshape(2,2,2)
`;
  let expectedAValue,
    expectedBValue,
    expectedXValue = 99;
  if (testName == "JSON") {
    expectedAValue = [[0, 1, 2, 3, 4], [5, 6, 7, 8, 9], [10, 11, 12, 13, 14]];
    expectedBValue = [[[0, 1], [2, 3]], [[4, 5], [6, 7]]];
  } else {
    expectedAValue = [
      new Int32Array([0, 1, 2, 3, 4]),
      new Int32Array([5, 6, 7, 8, 9]),
      new Int32Array([10, 11, 12, 13, 14])
    ];
    expectedBValue = [
      [new Uint16Array([0, 1]), new Uint16Array([2, 3])],
      [new Uint16Array([4, 5]), new Uint16Array([6, 7])]
    ];
  }

  test("trivial eval test", async () => {
    await expect(scope.eval("1+1")).resolves.toBe(2);
  });

  test("basic NDArray handling", async () => {
    await expect(scope.exec(defaultPyCode)).resolves.toBe(true);

    await expect(scope.eval("a.shape")).resolves.toEqual([3, 5]);
    await expect(scope.eval("b.shape")).resolves.toEqual([2, 2, 2]);
    await expect(scope.eval("a.ndim")).resolves.toBe(2);
    await expect(scope.eval("b.ndim")).resolves.toBe(3);
    await expect(scope.eval("a.dtype.name")).resolves.toBe("int32");
    await expect(scope.eval("b.dtype.name")).resolves.toBe("uint16");

    await expect(scope.eval("a")).resolves.toEqual(expectedAValue);
    await expect(scope.eval("b")).resolves.toEqual(expectedBValue);
    await expect(scope.eval('{"a": a, "b": b}')).resolves.toEqual({
      a: expectedAValue,
      b: expectedBValue
    });
  });

  test("eval2 and deferred finalization", async () => {
    await expect(scope.exec(defaultPyCode)).resolves.toBe(true);

    const x = await scope.eval2("[a]");
    const y = await scope.eval2("[a]", { copyOutOfShmem: true });
    const z = await scope.eval2("[a]", { copyOutOfShmem: false });
    const a = await scope.eval2("[a, b, x]", { copyOutOfShmem: false });

    expect(x.value).toEqual([expectedAValue]);
    expect(y.value).toEqual([expectedAValue]);
    expect(z.value).toEqual([expectedAValue]);
    expect(a.value).toEqual([expectedAValue, expectedBValue, expectedXValue]);

    await expect(x.finalize()).resolves.toBe(true);
    await expect(y.finalize()).resolves.toBe(true);
    await expect(z.finalize()).resolves.toBe(true);
    await expect(a.finalize()).resolves.toBe(true);
  });
});
