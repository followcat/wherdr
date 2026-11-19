import path from 'node:path'

// File paths on a machine, chosen from its home: a POSIX home ("/home/me", a
// Linux or macOS machine, also reached from a Windows host) takes POSIX paths,
// any other home (C:\Users\me) the host platform's. Node's default `path` is
// path.win32 on Windows, which would turn a remote "/home/me" into "\home\me".
export function machinePath(home: string): path.PlatformPath {
  return home.startsWith('/') ? path.posix : path
}
