// Minimal harness: transpile TS/TSX on require, shim 'claude-code/testing', run *.test.ts.
const fs = require('fs'), path = require('path'), Module = require('module')
const ts = require(path.join(__dirname, '..', 'node_modules', 'typescript'))
global.h = (tag, props, ...kids) => ({ tag, props: props || {}, kids })
const origResolve = Module._resolveFilename
const tests = []
const shim = {
  test: (name, ...rest) => tests.push({ name, fn: rest[rest.length - 1] }),
  describe: (n, b) => b(),
  expect: v => ({
    toBe: x => { if (!Object.is(v, x)) throw new Error(`expected ${JSON.stringify(v)} toBe ${JSON.stringify(x)}`) },
    toEqual: x => { if (JSON.stringify(v) !== JSON.stringify(x)) throw new Error(`expected ${JSON.stringify(v)} toEqual ${JSON.stringify(x)}`) },
  }),
}
for (const ext of ['.ts', '.tsx']) {
  require.extensions[ext] = (m, f) => {
    const out = ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h' }, fileName: f })
    m._compile(out.outputText, f)
  }
}
const origLoad = Module._load
Module._load = function (req, parent, isMain) {
  if (req === 'claude-code/testing') return shim
  if (req === 'claude-code') return { atom: () => ({}), read: async () => undefined, update: async () => undefined }
  return origLoad.apply(this, arguments)
}
const files = process.argv.slice(2)
for (const f of files) require(path.resolve(f))
;(async () => {
  let fail = 0
  for (const t of tests) {
    try { await t.fn(); console.log('  ok  ', t.name) } catch (e) { fail++; console.log('  FAIL', t.name, '\n      ', e.message) }
  }
  console.log(`${tests.length - fail}/${tests.length} passed`)
  process.exit(fail ? 1 : 0)
})()
