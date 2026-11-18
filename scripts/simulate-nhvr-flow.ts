import * as jwt from 'jsonwebtoken';
import http from 'http';

const BASE_HOST = 'localhost';
const BASE_PORT = 3001;
const JWT_SECRET = process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me-32chars';
const DRIVER_USER_ID = '428e6a29-bbda-4b9f-a319-94bf1547ec0d';
const DRIVER_EMAIL = 'driver.qa@yopmail.com';

const token = jwt.sign(
  {
    sub: DRIVER_USER_ID,
    email: DRIVER_EMAIL,
    role: 'DRIVER',
    typ: 'access',
    kind: 'user',
  },
  JWT_SECRET,
  { expiresIn: '2h' },
);

function apiCall(path: string, method: string = 'GET', data: any = null, authToken?: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const postData = data ? JSON.stringify(data) : '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(postData)),
    };
    if (authToken !== undefined ? authToken : token) {
      headers['Authorization'] = `Bearer ${authToken !== undefined ? authToken : token}`;
    }

    const req = http.request(
      {
        hostname: BASE_HOST,
        port: BASE_PORT,
        path: `/v1${path}`,
        method,
        headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 500, body: raw ? JSON.parse(raw) : {} });
          } catch {
            resolve({ status: res.statusCode || 500, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`❌ FAILED: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✅ ${msg}`);
}

async function runSimulation() {
  console.log('======================================================================');
  console.log('🚀 SIMULATING COMPLETE NHVR GEN 2.0 / EWD WORKFLOW IN CLOX');
  console.log('======================================================================\n');

  // Case 1: Initial EWD Status
  console.log('📌 Case 1: Get Driver EWD Status (Countdown, Current Activity, Breaches)');
  const statusRes1 = await apiCall('/driver/ewd/status');
  assert(statusRes1.status === 200, 'Status code 200 returned');
  assert(typeof statusRes1.body.currentActivity === 'string', `Current activity: ${statusRes1.body.currentActivity}`);
  assert(typeof statusRes1.body.minutesUntilBreakRequired === 'number', `Minutes until break: ${statusRes1.body.minutesUntilBreakRequired} min`);
  console.log(`   Current: ${statusRes1.body.currentActivity} | Remaining: ${statusRes1.body.minutesUntilBreakRequired}m | 24h Work: ${statusRes1.body.workMinutesLast24h}m\n`);

  // Case 2: Switch to REST (Driver takes mandatory 15-minute rest break)
  console.log('📌 Case 2: Driver Takes a Rest Break (Switch Activity to REST)');
  const restSwitch = await apiCall('/driver/ewd/activity', 'POST', {
    activity: 'REST',
    odometer: 1050,
    location: 'BP Truckstop, Melbourne VIC',
    latitude: -37.8136,
    longitude: 144.9631,
    vehicleRego: 'CLOX01',
  });
  assert(restSwitch.status === 201, 'Activity switch returned 201 Created');
  assert(restSwitch.body.record?.activity === 'REST', 'Record switched to REST');
  console.log(`   Recorded REST at BP Truckstop (Odo: 1050km, Rego: CLOX01)\n`);

  // Case 3: Verify Updated Status during REST
  console.log('📌 Case 3: Verify Status Reflects Resting State');
  const statusRes2 = await apiCall('/driver/ewd/status');
  assert(statusRes2.status === 200, 'Status check 200 returned');
  assert(statusRes2.body.currentActivity === 'REST', 'Active activity is REST');
  console.log(`   Active status verified as REST\n`);

  // Case 4: Resume WORK (Driver finishes break, resumes driving)
  console.log('📌 Case 4: Driver Resumes Work / Driving');
  const workSwitch = await apiCall('/driver/ewd/activity', 'POST', {
    activity: 'WORK',
    workType: 'DRIVING',
    odometer: 1050,
    location: 'BP Truckstop, Melbourne VIC',
    latitude: -37.8136,
    longitude: 144.9631,
    vehicleRego: 'CLOX01',
  });
  assert(workSwitch.status === 201, 'Resumed WORK with 201 Created');
  assert(workSwitch.body.record?.activity === 'WORK', 'Record switched to WORK');
  console.log(`   Active status returned to WORK (Driving)\n`);

  // Case 5: Manual Record / Backfill Correction
  console.log('📌 Case 5: Driver Creates Manual Entry (s319 HVNL Audit Trail)');
  const yesterday = new Date(Date.now() - 3600_000 * 2);
  const oneHourAgo = new Date(Date.now() - 3600_000);
  const manualRecord = await apiCall('/driver/ewd/records', 'POST', {
    activity: 'WORK',
    workType: 'OTHER',
    startTime: yesterday.toISOString(),
    endTime: oneHourAgo.toISOString(),
    locationStart: 'Depot A',
    locationEnd: 'Depot A',
    vehicleRego: 'CLOX01',
    editReason: 'Manual entry for pre-trip warehouse loading',
  });
  assert(manualRecord.status === 201, 'Manual record accepted with 201 Created');
  assert(manualRecord.body.isEdited === true, 'Flagged as edited with statutory audit trail');
  console.log(`   Manual 60-min LOADING entry logged with audit reason\n`);

  // Case 6: Get Today 24-Hour Daily Sheet
  console.log('📌 Case 6: Retrieve 24-Hour EWD Daily Compliance Sheet');
  const sheetRes = await apiCall('/driver/ewd/sheet/today');
  assert(sheetRes.status === 200, 'Daily sheet 200 returned');
  assert(sheetRes.body.driverId === 'a0343d67-478a-450b-90d9-01145052ed82', 'Belongs to active driver');
  assert(typeof sheetRes.body.status === 'string', `Daily sheet status: ${sheetRes.body.status}`);
  console.log(`   Retrieved daily sheet: ${sheetRes.body.date} (${sheetRes.body.status}) Timezone: ${sheetRes.body.timezone}\n`);

  // Case 7: Digital Sign-off (s319 Statutory Declaration)
  console.log('📌 Case 7: Driver Signs Daily Sheet (HVNL s319 Electronic Attestation)');
  const signRes = await apiCall('/driver/ewd/sheet/sign', 'POST', {
    date: new Date().toISOString().slice(0, 10),
    signature: 'DATA:IMAGE/PNG;BASE64,QA_DRIVER_DIGITAL_SIG',
    declarationAccepted: true,
  });
  assert(signRes.status === 201, 'Daily sheet signed successfully with 201');
  assert(signRes.body.status === 'SUBMITTED', 'Daily sheet status moved to SUBMITTED');
  console.log(`   s319 declaration signed and locked\n`);

  // Case 8: Roadside Mode - Generate 4-Digit Temporary PIN
  console.log('📌 Case 8: Driver Generates Roadside 4-Digit Temporary PIN');
  const pinRes = await apiCall('/driver/ewd/roadside/pin', 'POST', {});
  assert(pinRes.status === 201, 'Roadside PIN generated with 201');
  const pin = pinRes.body.accessPin || pinRes.body.pin;
  assert(typeof pin === 'string' && pin.length === 4, `4-digit PIN generated: ${pin}`);
  console.log(`   Temporary PIN: ${pin} (Expires at: ${pinRes.body.expiresAt})\n`);

  // Case 9: Roadside Officer Audit Inspection (Public Endpoint)
  console.log('📌 Case 9: Police / NHVR Authorised Officer Audits via Roadside Public Portal');
  const officerAudit = await apiCall('/public/roadside/inspect', 'POST', { pin }, '');
  assert(officerAudit.status === 201 || officerAudit.status === 200, 'Roadside inspection succeeded');
  assert(officerAudit.body.driver?.fullName === 'QA Driver', `Officer verified Driver: ${officerAudit.body.driver?.fullName}`);
  assert(typeof officerAudit.body.driver?.licenceNo === 'string' && officerAudit.body.driver.licenceNo.length > 0, `Officer verified Licence: ${officerAudit.body.driver?.licenceNo}`);
  assert(Array.isArray(officerAudit.body.records), `Officer received 28-day compliance records (${officerAudit.body.records.length} records)`);
  console.log(`   Officer viewed 28-day record history securely without touching driver device\n`);

  // Case 10: History Retrieval
  console.log('📌 Case 10: Driver Queries 7-Day History');
  const historyRes = await apiCall('/driver/ewd/records?days=7');
  assert(historyRes.status === 200, '7-day records returned 200');
  assert(Array.isArray(historyRes.body), `Driver retrieved ${historyRes.body.length} historical record(s)`);
  console.log(`   Historical records verified\n`);

  console.log('======================================================================');
  console.log('🎉 ALL 10 NHVR EWD SIMULATION FLOWS PASSED WITH 100% SUCCESS!');
  console.log('======================================================================');
}

runSimulation().catch((err) => {
  console.error('Simulation error:', err);
  process.exit(1);
});
