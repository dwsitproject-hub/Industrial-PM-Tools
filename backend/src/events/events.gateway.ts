import { Injectable } from '@nestjs/common';
import {
  OnGatewayConnection, WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { JwtUser } from '../common/auth.types';

@WebSocketGateway({ path: '/ws', cors: { origin: true, credentials: true } })
@Injectable()
export class EventsGateway implements OnGatewayConnection {
  @WebSocketServer()
  server!: Server;

  constructor(private jwt: JwtService) {}

  handleConnection(client: Socket) {
    try {
      const token = (client.handshake.auth && client.handshake.auth.token) || '';
      // AR-08: pinned here too — the websocket handshake is an authentication boundary like
      // any other, and it was verifying without constraining the algorithm.
      const user = this.jwt.verify<JwtUser>(token, {
        secret: process.env.JWT_ACCESS_SECRET, algorithms: ['HS256'],
      });
      client.data.user = user;
      client.join(`user:${user.sub}`);
      // AR-03: an external user must NOT join the workspace room. Even though event payloads
      // carry identifiers only, receiving them would disclose the existence, timing and
      // volume of another company's work — and the ids to try fetching.
      if (user.ext) {
        if (user.co) client.join(`co:${user.co}`);
      } else if (user.role === 'SITE_ADMIN' && user.siteId) {
        client.join(`site:${user.siteId}`);
      } else {
        client.join(`ws:${user.ws}`);
      }
    } catch {
      client.disconnect(true);
    }
  }

  /**
   * Emit to the internal workspace room, and to the narrower rooms the entity belongs to.
   * External companies only ever hear about their own records.
   */
  emitTicket(event: string, payload: {
    id: string; workspaceId: string; siteId?: string | null; companyId?: string | null;
    changed?: string[];
  }) {
    this.server?.to(`ws:${payload.workspaceId}`).emit(event, payload);
    if (payload.siteId) this.server?.to(`site:${payload.siteId}`).emit(event, payload);
    if (payload.companyId) this.server?.to(`co:${payload.companyId}`).emit(event, payload);
  }

  emitWorkspace(workspaceId: string, event: string, payload: unknown) {
    this.server?.to(`ws:${workspaceId}`).emit(event, payload);
  }

  emitUser(userId: string, event: string, payload: unknown) {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }
}
