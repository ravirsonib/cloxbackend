import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AppRole } from '../../shared/types';
import { InAppNotificationsService } from './in-app-notifications.service';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly inbox: InAppNotificationsService) {}

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    AppRole.SENDER,
    AppRole.TRANSPORT_COMPANY,
    AppRole.DRIVER,
    AppRole.SUPER_ADMIN,
    AppRole.STATE_MASTER,
    AppRole.LOCAL_BDE,
  )
  @ApiOperation({
    summary: 'List in-app notifications for the current marketplace user or Ops admin',
  })
  list(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Query('limit') limitRaw?: string,
    @Query('cursor') cursor?: string,
  ) {
    const limit = limitRaw ? Number(limitRaw) : undefined;
    return this.inbox.listForPrincipal(principal, {
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: cursor || undefined,
    });
  }

  @Get('unread-count')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    AppRole.SENDER,
    AppRole.TRANSPORT_COMPANY,
    AppRole.DRIVER,
    AppRole.SUPER_ADMIN,
    AppRole.STATE_MASTER,
    AppRole.LOCAL_BDE,
  )
  @ApiOperation({ summary: 'Unread in-app notification count' })
  unreadCount(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.inbox.unreadCount(principal);
  }

  @Post('read-all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    AppRole.SENDER,
    AppRole.TRANSPORT_COMPANY,
    AppRole.DRIVER,
    AppRole.SUPER_ADMIN,
    AppRole.STATE_MASTER,
    AppRole.LOCAL_BDE,
  )
  @ApiOperation({ summary: 'Mark all notifications as read' })
  markAllRead(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.inbox.markAllRead(principal);
  }

  @Post(':id/read')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    AppRole.SENDER,
    AppRole.TRANSPORT_COMPANY,
    AppRole.DRIVER,
    AppRole.SUPER_ADMIN,
    AppRole.STATE_MASTER,
    AppRole.LOCAL_BDE,
  )
  @ApiOperation({ summary: 'Mark one notification as read' })
  markRead(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.inbox.markRead(principal, id);
  }
}
