import { createServer } from 'node:net'

export function isLocalPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') resolve(false)
      else reject(error)
    })
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close((error) => {
        if (error) reject(error)
        else resolve(true)
      })
    })
  })
}

export async function assertLocalPortsAvailable(ports: readonly number[]): Promise<void> {
  for (const port of new Set(ports)) {
    if (!(await isLocalPortAvailable(port))) {
      throw new Error(`本机端口 ${port} 已占用或不可绑定，请停止对应服务或更换端口`)
    }
  }
}
