// jshint esversion: 6
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const options = [
  ["JSON", { codec: "json" }],
  ["BSON", { codec: "bson" }],
  [
    "JSON-SHMEM",
    {
      codec: "json",
      shmemSize: 10 * 1024 * 1024,
      shmemPath: path.join(
        os.tmpdir(),
        "shobj_" + crypto.randomBytes(8).toString("hex") + ".mem"
      )
    }
  ],
  [
    "BSON-SHMEM",
    {
      codec: "bson",
      shmemSize: 10 * 1024 * 1024,
      shmemPath: path.join(
        os.tmpdir(),
        "shobj_" + crypto.randomBytes(8).toString("hex") + ".mem"
      )
    }
  ]
];

module.exports = options;
