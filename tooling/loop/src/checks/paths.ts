/**
 * Which files a content-pattern check may read.
 *
 * Several checks look for a marker in the lines a pull request adds: a
 * `@ts-nocheck`, a `.only`, a `console.log`. Those markers mean what the check
 * thinks they mean only in code. In prose they are the subject of a sentence —
 * a skill file telling an agent never to add a `@ts-nocheck` contains the
 * string for exactly the reason the check exists, and flagging it blocks the
 * pull request that wrote the rule down.
 *
 * So content-pattern checks run over source files. Checks that do not depend on
 * a file being code — a leaked credential is a leak in any file — deliberately
 * do not use this.
 */
const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/

export function isCodeFile(path: string): boolean {
  return CODE_FILE.test(path)
}
