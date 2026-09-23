import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req,
} from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, JwtUser, RequirePerm } from '../common/auth.types';
import { Heavy } from '../common/throttle';
import { TicketsService } from './tickets.service';
import { CreateNoteDto, CreateTicketDto, ListTicketsQuery, UpdateTicketDto } from './tickets.dto';
import { ServiceScoped } from '../common/route-policy';

@Controller('tickets')
export class TicketsController {
  constructor(private tickets: TicketsService) {}

  @ServiceScoped('row scope: site hard-filter plus ALL/OWN ticket scope')
  @Heavy()
  @Get()
  list(@CurrentUser() user: JwtUser, @Query() q: ListTicketsQuery) {
    return this.tickets.list(user, q);
  }

  @ServiceScoped('aggregates computed over the caller row scope only')
  @Heavy()
  @Get('stats')
  stats(@CurrentUser() user: JwtUser) {
    return this.tickets.stats(user);
  }

  @RequirePerm('tickets', 'create')
  @Post()
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateTicketDto, @Req() req: Request) {
    return this.tickets.create(user, dto, req.ip);
  }

  @ServiceScoped('out-of-scope tickets answer 404, so existence is not disclosed')
  @Get(':id')
  get(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.tickets.getById(user, id);
  }

  @ServiceScoped('per-field editable envelope plus row scope')
  @Patch(':id')
  update(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: UpdateTicketDto, @Req() req: Request) {
    return this.tickets.update(user, id, dto, req.ip);
  }

  @ServiceScoped('tickets.delete plus the own/new-only envelope')
  @Delete(':id')
  remove(@CurrentUser() user: JwtUser, @Param('id') id: string, @Req() req: Request) {
    return this.tickets.softDelete(user, id, req.ip);
  }

  // AR-06: restoring a deleted ticket is a write. It used to be gated on stAudit.view, so
  // granting a role visibility of the audit trail silently granted it the power to
  // resurrect records. It now requires the same permission as deleting one.
  @RequirePerm('tickets', 'delete')
  @Post(':id/restore')
  @HttpCode(200)
  restore(@CurrentUser() user: JwtUser, @Param('id') id: string, @Req() req: Request) {
    return this.tickets.restore(user, id, req.ip);
  }

  @ServiceScoped('notes follow the parent ticket row scope')
  @Get(':id/notes')
  listNotes(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.tickets.listNotes(user, id);
  }

  @ServiceScoped('notes follow the parent ticket row scope')
  @Post(':id/notes')
  addNote(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: CreateNoteDto, @Req() req: Request) {
    return this.tickets.addNote(user, id, dto.content, req.ip);
  }
}
