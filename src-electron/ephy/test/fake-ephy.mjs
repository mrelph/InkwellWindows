#!/usr/bin/env node
/* A fake `ephy` CLI for tests. Never the real one. The behaviour is chosen
   by a leading `--fake-mode=<mode>` argument (the launcher strips the
   environment, so a variable would not arrive); the rest are the CLI's args.

   Modes:
     echo         arguments (one per line) then stdin, on stdout
     list         `post list --json` rows, like the Mac tests
     get          one artifact (version 2)
     update       {"postId":...,"version":6}; fails with a base-version error
                  when --base-version is 1
     new          {"postId":"Nn1Nn2Nn3Nn4","version":1}
     open         {"viewerUrl":"https://ephy.example.com/..."}
     signedout    exit 1, "Run mwinit to sign in" on stderr
     hang         never exits (timeout test)
     ignorestdin  exits 3 immediately without reading stdin
     env          prints EPHY_NO_UPGRADE_CHECK|EPHY_VIA_AGENT|cwd */

import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const modeArg = argv[0]?.startsWith('--fake-mode=') ? argv.shift() : undefined
const args = argv
const mode = modeArg ? modeArg.slice('--fake-mode='.length) : 'echo'

const readStdin = () => {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

const listJson = {
  artifacts: [
    { postId: 'aB3dK9xQ2mZp', kind: 'artifact', format: 'MARKDOWN', title: 'Sprint notes', updatedAt: 1794847781.902 },
    { postId: 'Zz9Yy8Xx7Ww6', kind: 'artifact', format: 'TEXT', title: '  ', updatedAt: '2026-11-04T04:37:17.354417218Z' },
    { postId: 'Hh1Hh2Hh3Hh4', kind: 'artifact', format: 'HTML', title: 'A page' },
    { postId: 'Ss1Ss2Ss3Ss4', kind: 'site', format: 'MARKDOWN', title: 'A site' },
    { postId: '-rm-rf', kind: 'artifact', format: 'MARKDOWN', title: 'Bad id' }
  ]
}

switch (mode) {
  case 'echo':
    process.stdout.write(args.map((a) => `${a}\n`).join('') + readStdin())
    break
  case 'list':
    process.stdout.write(JSON.stringify(listJson))
    break
  case 'get':
    process.stdout.write(JSON.stringify({ postId: args[2] ?? 'aB3dK9xQ2mZp', kind: 'artifact', format: 'MARKDOWN', title: 'Notes', version: 2, content: '# Hi\n' }))
    break
  case 'update': {
    const base = args.indexOf('--base-version')
    if (base >= 0 && args[base + 1] === '1') {
      process.stderr.write('base-version 1 is not the head (v3)\n')
      process.exit(1)
    }
    // Echo what arrived on stdin back as its length only, so tests can check
    // the upload without the fake printing note text.
    const body = readStdin()
    process.stdout.write(JSON.stringify({ postId: args[2] ?? 'aB3dK9xQ2mZp', version: 6, bytes: Buffer.byteLength(body) }))
    break
  }
  case 'new':
    readStdin()
    process.stdout.write(JSON.stringify({ postId: 'Nn1Nn2Nn3Nn4', version: 1 }))
    break
  case 'open':
    process.stdout.write(JSON.stringify({ viewerUrl: 'https://ephy.example.com/aB3dK9xQ2mZp/notes' }))
    break
  case 'signedout':
    process.stderr.write('Run mwinit to sign in\n')
    process.exit(1)
    break
  case 'hang':
    setInterval(() => undefined, 1000)
    break
  case 'ignorestdin':
    process.exit(3)
    break
  case 'env':
    process.stdout.write(`${process.env.EPHY_NO_UPGRADE_CHECK}|${process.env.EPHY_VIA_AGENT}|${process.cwd()}`)
    break
  default:
    process.stderr.write(`unknown fake mode ${mode}\n`)
    process.exit(2)
}
