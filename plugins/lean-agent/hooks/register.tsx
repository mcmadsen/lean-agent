import type { Register } from 'claude-code'

import { detectRole } from './role'
import type { Role } from './role'

let role: Role = { kind: 'plain' }
export const currentRole = () => role

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    role = await detectRole($ as any, e.cwd)
    return next(e)
  })
}
