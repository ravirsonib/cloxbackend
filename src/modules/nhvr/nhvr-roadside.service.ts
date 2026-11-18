import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class NhvrRoadsideService {
  constructor(private readonly prisma: PrismaService) {}

  private generateRandomPin(): string {
    return Math.floor(1000 + Math.random() * 9000).toString();
  }

  async createRoadsideSession(driverId: string) {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
    const pin = this.generateRandomPin();
    await this.prisma.ewdRoadsideSession.updateMany({
      where: { driverId, isActive: true },
      data: { isActive: false },
    });
    return this.prisma.ewdRoadsideSession.create({
      data: { driverId, accessPin: pin, expiresAt, isActive: true },
    });
  }

  async verifyPin(pin: string) {
    const session = await this.prisma.ewdRoadsideSession.findFirst({
      where: { accessPin: pin, isActive: true, expiresAt: { gt: new Date() } },
      include: { driver: { include: { user: true } } },
    });
    if (!session) {
      throw new UnauthorizedException('Invalid or expired roadside inspection PIN');
    }
    await this.prisma.ewdRoadsideSession.update({
      where: { id: session.id },
      data: { accessedCount: { increment: 1 }, lastAccessedAt: new Date() },
    });
    return session;
  }

  async get28DayInspectionData(driverId: string) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 28);
    const [records, sheets, breaches] = await Promise.all([
      this.prisma.ewdWorkRestRecord.findMany({
        where: { driverId, startTime: { gte: startDate } },
        orderBy: { startTime: 'desc' },
      }),
      this.prisma.ewdDailySheet.findMany({
        where: { driverId, date: { gte: startDate } },
        orderBy: { date: 'desc' },
      }),
      this.prisma.ewdBreachRecord.findMany({
        where: { driverId, detectedAt: { gte: startDate } },
        orderBy: { detectedAt: 'desc' },
      }),
    ]);
    return { records, sheets, breaches };
  }

  async inspectByPin(pin: string) {
    const session = await this.verifyPin(pin);
    const inspectionData = await this.get28DayInspectionData(session.driverId);
    return {
      inspectorSessionId: session.id,
      driver: {
        id: session.driver.id,
        fullName: session.driver.user.name || 'Unknown Driver',
        licenceNo: session.driver.licenceNo,
        licenceClass: session.driver.licenceClass,
        fatigueScheme: session.driver.fatigueScheme,
        baseTimezone: session.driver.baseTimezone,
      },
      ...inspectionData,
    };
  }
}
