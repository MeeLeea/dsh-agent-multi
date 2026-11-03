import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export class PingController extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'pingController')
  }

  @Remote('ping')
  async ping(): Promise<{ pong: true }> {
    return { pong: true }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    pingController: PingController
  }
}
