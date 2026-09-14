import {
  IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsString,
  IsUUID, Max, MaxLength, Min, MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export const WORK_TYPES = ['PROJECT_TENDER', 'OPS_TENDER', 'SITE_INSTRUCTION', 'BUDGETING_INTERNAL'];
export const PRIORITIES = ['URGENT', 'NORMAL', 'LOW'];
export const STATUSES = ['NEW', 'IN_PROGRESS_ESTIMATION', 'IN_PROGRESS_TENDER', 'DONE', 'HOLD'];
export const SOURCES = ['WHATSAPP', 'EMAIL', 'VERBAL'];
export const TENDER_STATUSES = ['SUBMITTED', 'WON', 'LOST', 'CANCELLED'];

export class CreateTicketDto {
  @IsString() @MinLength(3) @MaxLength(200) name!: string;
  @IsIn(WORK_TYPES) type!: string;
  @IsIn(PRIORITIES) priority!: string;
  @IsDateString() deadline!: string;
  @IsOptional() @IsBoolean() allowPast?: boolean;
  @IsOptional() @IsString() @MaxLength(120) requestor?: string;
  @IsOptional() @IsIn(SOURCES) source?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsUUID() assigneeId?: string;
  @IsOptional() @IsUUID() siteId?: string;
}

export class UpdateTicketDto {
  @IsInt() @Min(1) version!: number;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) name?: string;
  @IsOptional() @IsIn(WORK_TYPES) type?: string;
  @IsOptional() @IsIn(PRIORITIES) priority?: string;
  @IsOptional() @IsIn(STATUSES) status?: string;
  @IsOptional() @IsDateString() deadline?: string;
  @IsOptional() @IsString() @MaxLength(120) requestor?: string;
  @IsOptional() @IsIn(SOURCES) source?: string | null;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  /** null clears the assignment */
  @IsOptional() assigneeId?: string | null;
  @IsOptional() @IsIn(TENDER_STATUSES) tenderStatus?: string | null;
  @IsOptional() @IsNumber() @Min(0) tenderValue?: number | null;
}

export class ListTicketsQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @IsIn(STATUSES) status?: string;
  @IsOptional() @IsIn(WORK_TYPES) type?: string;
  @IsOptional() @IsIn(PRIORITIES) priority?: string;
  /** uuid or the literal "unassigned" or "me" */
  @IsOptional() @IsString() assigneeId?: string;
  @IsOptional() @IsUUID() siteId?: string;
  @IsOptional() @IsIn(['true', 'false']) overdue?: string;
  @IsOptional() @IsIn(['createdAt', '-createdAt', 'deadline', '-deadline', 'priority', '-priority']) sort?: string;
  @IsOptional() @IsIn(['true', 'false']) includeDeleted?: string;
}

export class CreateNoteDto {
  @IsString() @MinLength(1) @MaxLength(2000) content!: string;
}
