import { expect, test } from 'claude-code/testing'
import { hmac, sha256 } from './reviews'

const enc = (s: string) => new TextEncoder().encode(s)
const bytes = (hexs: string) => Uint8Array.from(hexs.match(/../g) ?? [], b => parseInt(b, 16))
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('')

test('sha256 known answers (FIPS 180-4)', () => {
  expect(hex(sha256(enc('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  expect(hex(sha256(enc('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  expect(hex(sha256(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
})

test('hmac-sha256 known answers (RFC 4231 cases 1, 2, 3, 6)', () => {
  expect(hex(hmac(bytes('0b'.repeat(20)), enc('Hi There')))).toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7')
  expect(hex(hmac(enc('Jefe'), enc('what do ya want for nothing?')))).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
  expect(hex(hmac(bytes('aa'.repeat(20)), bytes('dd'.repeat(50))))).toBe('773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe')
  // key longer than the block size is hashed first
  expect(hex(hmac(bytes('aa'.repeat(131)), enc('Test Using Larger Than Block-Size Key - Hash Key First')))).toBe('60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54')
})
