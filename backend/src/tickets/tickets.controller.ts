import {
  Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req,
} from '@nestjs/common';
import { Request } from 'express';
import { CurrentUser, JwtUser, RequirePerm } from '../common/auth.types';
import { TicketsService } from './tickets.service';
import { CreateNoteDto, CreateTicketDto, ListTicketsQuery, UpdateTicketDto } from './tickets.dto';

@Controller('tickets')
export class TicketsController {
  constructor(private tickets: TicketsService) {}

  @Get()
  list(@CurrentUser() user: JwtUser, @Query() q: ListTicketsQuery) {
    return this.tickets.list(user, q);
  }

  @Get('stats')
  stats(@CurrentUser() user: JwtUser) {
    return this.tickets.stats(user);
  }

  @RequirePerm('tickets', 'create')
  @Post()
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateTicketDto, @Req() req: Request) {
    return this.tickets.create(user, dto, req.ip);
  }

  @Get(':id')
  get(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.tickets.getById(user, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: UpdateTicketDto, @Req() req: Request) {
    return this.tickets.update(user, id, dto, req.ip);
  }

  @Delete(':id')
  remove(@CurrentUser() user: JwtUser, @Param('id') id: string, @Req() req: Request) {
    return this.tickets.softDelete(user, id, req.ip);
  }

  @RequirePerm('stAudit', 'view')
  @Post(':id/restore')
  @HttpCode(200)
  restore(@CurrentUser() user: JwtUser, @Param('id') id: string, @Req() req: Request) {
    return this.tickets.restore(user, id, req.ip);
  }

  @Get(':id/notes')
  listNotes(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.tickets.listNotes(user, id);
  }

  @Post(':id/notes')
  addNote(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: CreateNoteDto, @Req() req: Request) {
    return this.tickets.addNote(user, id, dto.content, req.ip);
  }
}
