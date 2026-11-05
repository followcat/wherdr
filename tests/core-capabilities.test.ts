import { describe, expect, it } from 'vitest'
import core16 from './fixtures/core-0.1.16.json'
import core17 from './fixtures/core-0.1.17.json'
import { coreCapabilities, hasPort } from '../shared/coreCapabilities'

describe('herdr-core capabilities from rpc.discover', () => {
  it('reads host:port support from the recorded 0.1.16 and 0.1.17 documents', () => {
    expect(coreCapabilities(core16.discover)).toEqual({ hostPort: false })
    expect(coreCapabilities(core17.discover)).toEqual({ hostPort: true })
  })
  it('never infers support from the version: a 0.1.16 document labelled newer stays without ports', () => {
    expect(coreCapabilities({ ...core16.discover, info: { ...core16.discover.info, version: '0.2.0' } })).toEqual({ hostPort: false })
  })
  it('treats a document without machine.add or its target as no port', () => {
    expect(coreCapabilities({ methods: [{ name: 'hello' }] })).toEqual({ hostPort: false })
    expect(coreCapabilities({ methods: [{ name: 'machine.add', params: [{ name: 'target' }] }] })).toEqual({ hostPort: false })
    expect(coreCapabilities(null)).toEqual({ hostPort: false })
  })
  it('recognizes a target with a port', () => {
    for (const t of ['me@10.0.0.7:2222', '[::1]:22', 'vps:22 ']) expect(hasPort(t)).toBe(true)
    for (const t of ['me@10.0.0.7', 'vps', 'box:']) expect(hasPort(t)).toBe(false)
  })
  it('keeps the recorded hello features of each version (resize_notifications from 0.1.17)', () => {
    expect(core16.hello.features).not.toContain('resize_notifications')
    expect(core17.hello.features).toContain('resize_notifications')
    expect(core16.hello.methods).toEqual(core16.discover.methods.map(m => m.name))
    expect(core17.hello.methods).toEqual(core17.discover.methods.map(m => m.name))
  })
})
