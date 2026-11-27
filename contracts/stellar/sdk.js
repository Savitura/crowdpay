/**
 * Resolves `@stellar/stellar-sdk` from whichever node_modules in this repo has
 * it installed. The example scripts live outside backend/, so a plain require
 * fails when they are imported (tests) or run from the repository root; the
 * backend package is the canonical owner of the dependency.
 */
const path = require("path");

let cached = null;

function loadStellarSdk() {
  if (cached) return cached;

  try {
    cached = require("@stellar/stellar-sdk");
  } catch {
    const backendModules = path.join(__dirname, "..", "..", "backend", "node_modules");
    cached = require(require.resolve("@stellar/stellar-sdk", { paths: [backendModules] }));
  }

  return cached;
}

module.exports = { loadStellarSdk };
