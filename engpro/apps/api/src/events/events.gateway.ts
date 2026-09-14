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
      const user = this.jwt.verify<JwtUser>(token, { secret: process.env.JWT_ACCESS_SECRET });
      client.data.user = user;
      client.join(`user:${user.sub}`);
      if (user.role === 'SITE_ADMIN' && user.siteId) client.join(`site:${user.siteId}`);
      else client.join(`ws:${user.ws}`);
    } catch {
      client.disconnect(true);
    }
  }

  /** Emit to the whole workspace and, when the entity is site-scoped, to that site's room too. */
  emitTicket(event: string, payload: { id: string; workspaceId: string; siteId?: string | null; changed?: string[] }) {
    this.server?.to(`ws:${payload.workspaceId}`).emit(event, payload);
    if (payload.siteId) this.server?.to(`site:${payload.siteId}`).emit(event, payload);
  }

  emitWorkspace(workspaceId: string, event: string, payload: unknown) {
    this.server?.to(`ws:${workspaceId}`).emit(event, payload);
  }

  emitUser(userId: string, event: string, payload: unknown) {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }
}
