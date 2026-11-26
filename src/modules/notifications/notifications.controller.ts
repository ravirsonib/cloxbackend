import {
  Body,
  Controller,
  Delete,
  Get,
  Optional,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal } from '../../common/decorators/current-admin.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard, type AuthenticatedPrincipal } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  AppRole,
  registerPushDeviceSchema,
  testPushSchema,
  unregisterPushDeviceSchema,
  updateNotificationPreferencesSchema,
  type RegisterPushDeviceInput,
  type TestPushInput,
  type UnregisterPushDeviceInput,
  type UpdateNotificationPreferencesInput,
} from '../../shared/types';
import { InAppNotificationsService } from './in-app-notifications.service';
import { PushDevicesService } from './push-devices.service';
import { PushDispatchService } from './push-dispatch.service';

@ApiTags('notifications', 'driver-app')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly inbox: InAppNotificationsService,
    @Optional() private readonly pushDevices?: PushDevicesService,
    @Optional() private readonly pushDispatch?: PushDispatchService,
  ) {}

  private requirePushDevices(): PushDevicesService {
    if (!this.pushDevices) {
      throw new ServiceUnavailableException('Push devices service unavailable');
    }
    return this.pushDevices;
  }

  private requirePushDispatch(): PushDispatchService {
    if (!this.pushDispatch) {
      throw new ServiceUnavailableException('Push dispatch service unavailable');
    }
    return this.pushDispatch;
  }

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
    @Query('unreadOnly') unreadOnlyRaw?: string,
  ) {
    const limit = limitRaw ? Number(limitRaw) : undefined;
    const unreadOnly = unreadOnlyRaw === 'true' || unreadOnlyRaw === '1';
    return this.inbox.listForPrincipal(principal, {
      limit: Number.isFinite(limit) ? limit : undefined,
      cursor: cursor || undefined,
      unreadOnly,
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

  @Put('devices')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    AppRole.SENDER,
    AppRole.TRANSPORT_COMPANY,
    AppRole.DRIVER,
    AppRole.SUPER_ADMIN,
    AppRole.STATE_MASTER,
    AppRole.LOCAL_BDE,
  )
  @ApiOperation({ summary: 'Register or refresh mobile/web push device token (FCM)' })
  registerDevice(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(registerPushDeviceSchema))
    body: RegisterPushDeviceInput,
  ) {
    return this.requirePushDevices().registerDevice(principal, body);
  }

  @Delete('devices')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    AppRole.SENDER,
    AppRole.TRANSPORT_COMPANY,
    AppRole.DRIVER,
    AppRole.SUPER_ADMIN,
    AppRole.STATE_MASTER,
    AppRole.LOCAL_BDE,
  )
  @ApiOperation({ summary: 'Unregister mobile/web push device token on logout' })
  unregisterDevice(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(unregisterPushDeviceSchema))
    body: UnregisterPushDeviceInput,
  ) {
    return this.requirePushDevices().unregisterDevice(principal, body);
  }

  @Get('devices')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    AppRole.SENDER,
    AppRole.TRANSPORT_COMPANY,
    AppRole.DRIVER,
    AppRole.SUPER_ADMIN,
    AppRole.STATE_MASTER,
    AppRole.LOCAL_BDE,
  )
  @ApiOperation({ summary: 'List active push devices for current user or Ops admin' })
  listDevices(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.requirePushDevices().listDevices(principal);
  }

  @Get('preferences')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    AppRole.SENDER,
    AppRole.TRANSPORT_COMPANY,
    AppRole.DRIVER,
    AppRole.SUPER_ADMIN,
    AppRole.STATE_MASTER,
    AppRole.LOCAL_BDE,
  )
  @ApiOperation({ summary: 'Get push notification preferences and quiet hours' })
  getPreferences(@CurrentPrincipal() principal: AuthenticatedPrincipal) {
    return this.requirePushDevices().getPreferences(principal);
  }

  @Patch('preferences')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    AppRole.SENDER,
    AppRole.TRANSPORT_COMPANY,
    AppRole.DRIVER,
    AppRole.SUPER_ADMIN,
    AppRole.STATE_MASTER,
    AppRole.LOCAL_BDE,
  )
  @ApiOperation({ summary: 'Update push notification preferences and quiet hours' })
  updatePreferences(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(updateNotificationPreferencesSchema))
    body: UpdateNotificationPreferencesInput,
  ) {
    return this.requirePushDevices().updatePreferences(principal, body);
  }

  @Post('test-push')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(
    AppRole.SENDER,
    AppRole.TRANSPORT_COMPANY,
    AppRole.DRIVER,
    AppRole.SUPER_ADMIN,
  )
  @ApiOperation({ summary: 'Send a test push notification to active devices (non-prod / Super Admin)' })
  sendTestPush(
    @CurrentPrincipal() principal: AuthenticatedPrincipal,
    @Body(new ZodValidationPipe(testPushSchema)) body: TestPushInput,
  ) {
    return this.requirePushDispatch().sendTestPush(principal, body);
  }

  @Get('push-stats')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(AppRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'Super Admin mobile push health and last-24h delivery stats' })
  getPushStats() {
    return this.requirePushDispatch().getPushStats();
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
