import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3002;

const EG4_BASE_URL = 'https://monitor.eg4electronics.com/WManage';

let sessionCookie = null;
let lastLoginTime = null;
let currentSerialNum = null;
const SESSION_TIMEOUT = 30 * 60 * 1000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function isSessionValid() {
  return sessionCookie && lastLoginTime && (Date.now() - lastLoginTime < SESSION_TIMEOUT);
}

function extractCookies(response) {
  const raw = response.headers.raw()['set-cookie'];
  if (!raw) return null;
  return raw.map(c => c.split(';')[0]).join('; ');
}

// POST /api/eg4/login - Authenticate with EG4 (account + password only)
// Returns list of stations (plants) with their inverters
app.post('/api/eg4/login', async (req, res) => {
  try {
    const { account, password } = req.body;
    if (!account || !password) {
      return res.status(400).json({ error: 'Account and password required' });
    }

    const formData = new URLSearchParams();
    formData.append('account', account);
    formData.append('password', password);

    const response = await fetch(`${EG4_BASE_URL}/web/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
      redirect: 'manual'
    });

    const cookies = extractCookies(response);
    if (!cookies) {
      return res.status(401).json({ error: 'Authentication failed - invalid credentials' });
    }
    
    sessionCookie = cookies;
    lastLoginTime = Date.now();
    console.log('EG4 login successful');

    // Fetch all plants (stations)
    const plantsRes = await fetch(`${EG4_BASE_URL}/web/config/plant/list/viewer`, {
      method: 'POST',
      headers: { 
        'Cookie': sessionCookie,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'page=1&rows=100'
    });
    const plantsData = await plantsRes.json();

    // For each plant, fetch its inverters
    const stations = [];
    for (const plant of (plantsData.rows || [])) {
      const invRes = await fetch(`${EG4_BASE_URL}/web/config/inverter/list`, {
        method: 'POST',
        headers: {
          'Cookie': sessionCookie,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `page=1&rows=50&plantId=${plant.id}`
      });
      const invData = await invRes.json();
      
      for (const inv of (invData.rows || [])) {
        stations.push({
          name: `${plant.name} — ${inv.deviceTypeText} (${inv.serialNum})`,
          plantName: plant.name,
          plantId: plant.id,
          serialNum: inv.serialNum,
          deviceType: inv.deviceTypeText,
          status: inv.statusText,
          address: plant.address || ''
        });
      }
    }

    res.json({ success: true, stations });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

// POST /api/eg4/select-station - Set active station
app.post('/api/eg4/select-station', (req, res) => {
  const { serialNum } = req.body;
  if (!serialNum) return res.status(400).json({ error: 'serialNum required' });
  currentSerialNum = serialNum;
  res.json({ success: true, serialNum: currentSerialNum });
});

// GET /api/eg4/status
app.get('/api/eg4/status', (req, res) => {
  res.json({
    connected: isSessionValid(),
    serialNum: currentSerialNum,
    lastLogin: lastLoginTime ? new Date(lastLoginTime).toISOString() : null
  });
});

// GET /api/eg4/working-modes - Read inverter register data and return working mode schedule
app.get('/api/eg4/working-modes', async (req, res) => {
  if (!isSessionValid()) return res.status(401).json({ error: 'Not authenticated' });
  if (!currentSerialNum) return res.status(400).json({ error: 'No station selected' });

  try {
    // Read registers in 3 batches (same as EG4 Monitor Center "Read" button)
    const batches = [
      { startRegister: 0, pointNumber: 127 },
      { startRegister: 127, pointNumber: 127 },
    ];

    const allFields = {};
    for (const batch of batches) {
      const resp = await fetch(`${EG4_BASE_URL}/web/maintain/remoteRead/read`, {
        method: 'POST',
        headers: { 'Cookie': sessionCookie, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `inverterSn=${currentSerialNum}&startRegister=${batch.startRegister}&pointNumber=${batch.pointNumber}`
      });
      const data = await resp.json();
      if (!data.success) return res.status(500).json({ error: 'Failed to read registers', batch });
      Object.assign(allFields, data);
    }

    // Parse AC Charge times (3 time slots)
    const acCharge = [];
    const acPrefixes = [
      { sh: 'HOLD_AC_CHARGE_START_HOUR', sm: 'HOLD_AC_CHARGE_START_MINUTE', eh: 'HOLD_AC_CHARGE_END_HOUR', em: 'HOLD_AC_CHARGE_END_MINUTE' },
      { sh: 'HOLD_AC_CHARGE_START_HOUR_1', sm: 'HOLD_AC_CHARGE_START_MINUTE_1', eh: 'HOLD_AC_CHARGE_END_HOUR_1', em: 'HOLD_AC_CHARGE_END_MINUTE_1' },
      { sh: 'HOLD_AC_CHARGE_START_HOUR_2', sm: 'HOLD_AC_CHARGE_START_MINUTE_2', eh: 'HOLD_AC_CHARGE_END_HOUR_2', em: 'HOLD_AC_CHARGE_END_MINUTE_2' },
    ];
    for (const p of acPrefixes) {
      const startH = parseInt(allFields[p.sh] || '0');
      const startM = parseInt(allFields[p.sm] || '0');
      const endH = parseInt(allFields[p.eh] || '0');
      const endM = parseInt(allFields[p.em] || '0');
      if (startH !== endH || startM !== endM) {
        acCharge.push({
          start: `${String(startH).padStart(2,'0')}:${String(startM).padStart(2,'0')}`,
          end: `${String(endH).padStart(2,'0')}:${String(endM).padStart(2,'0')}`
        });
      }
    }

    // Parse Peak Shaving times (2 time slots)
    const peakShaving = [];
    const peakEnabled = allFields['FUNC_GRID_PEAK_SHAVING'] === true || allFields['FUNC_GRID_PEAK_SHAVING'] === 'true';
    const psSlots = [
      { sh: 'LSP_HOLD_DIS_CHG_POWER_TIME_37', sm: 'LSP_HOLD_DIS_CHG_POWER_TIME_38', eh: 'LSP_HOLD_DIS_CHG_POWER_TIME_39', em: 'LSP_HOLD_DIS_CHG_POWER_TIME_40' },
      { sh: 'LSP_HOLD_DIS_CHG_POWER_TIME_41', sm: 'LSP_HOLD_DIS_CHG_POWER_TIME_42', eh: 'LSP_HOLD_DIS_CHG_POWER_TIME_43', em: 'LSP_HOLD_DIS_CHG_POWER_TIME_44' },
    ];
    for (const p of psSlots) {
      const startH = parseInt(allFields[p.sh] || '0');
      const startM = parseInt(allFields[p.sm] || '0');
      const endH = parseInt(allFields[p.eh] || '0');
      const endM = parseInt(allFields[p.em] || '0');
      if (startH !== endH || startM !== endM) {
        peakShaving.push({
          start: `${String(startH).padStart(2,'0')}:${String(startM).padStart(2,'0')}`,
          end: `${String(endH).padStart(2,'0')}:${String(endM).padStart(2,'0')}`
        });
      }
    }

    // Parse Forced Charge times
    const forcedCharge = [];
    const fcPrefixes = [
      { sh: 'HOLD_FORCED_CHARGE_START_HOUR', sm: 'HOLD_FORCED_CHARGE_START_MINUTE', eh: 'HOLD_FORCED_CHARGE_END_HOUR', em: 'HOLD_FORCED_CHARGE_END_MINUTE' },
      { sh: 'HOLD_FORCED_CHARGE_START_HOUR_1', sm: 'HOLD_FORCED_CHARGE_START_MINUTE_1', eh: 'HOLD_FORCED_CHARGE_END_HOUR_1', em: 'HOLD_FORCED_CHARGE_END_MINUTE_1' },
    ];
    for (const p of fcPrefixes) {
      const startH = parseInt(allFields[p.sh] || '0');
      const startM = parseInt(allFields[p.sm] || '0');
      const endH = parseInt(allFields[p.eh] || '0');
      const endM = parseInt(allFields[p.em] || '0');
      if (startH !== endH || startM !== endM) {
        forcedCharge.push({
          start: `${String(startH).padStart(2,'0')}:${String(startM).padStart(2,'0')}`,
          end: `${String(endH).padStart(2,'0')}:${String(endM).padStart(2,'0')}`
        });
      }
    }

    // Parse Forced Discharge times
    const forcedDischarge = [];
    const fdPrefixes = [
      { sh: 'HOLD_FORCED_DISCHARGE_START_HOUR', sm: 'HOLD_FORCED_DISCHARGE_START_MINUTE', eh: 'HOLD_FORCED_DISCHARGE_END_HOUR', em: 'HOLD_FORCED_DISCHARGE_END_MINUTE' },
      { sh: 'HOLD_FORCED_DISCHARGE_START_HOUR_1', sm: 'HOLD_FORCED_DISCHARGE_START_MINUTE_1', eh: 'HOLD_FORCED_DISCHARGE_END_HOUR_1', em: 'HOLD_FORCED_DISCHARGE_END_MINUTE_1' },
    ];
    for (const p of fdPrefixes) {
      const startH = parseInt(allFields[p.sh] || '0');
      const startM = parseInt(allFields[p.sm] || '0');
      const endH = parseInt(allFields[p.eh] || '0');
      const endM = parseInt(allFields[p.em] || '0');
      if (startH !== endH || startM !== endM) {
        forcedDischarge.push({
          start: `${String(startH).padStart(2,'0')}:${String(startM).padStart(2,'0')}`,
          end: `${String(endH).padStart(2,'0')}:${String(endM).padStart(2,'0')}`
        });
      }
    }

    // Battery settings
    const batterySettings = {
      acChargeStartSOC: parseInt(allFields['HOLD_AC_CHARGE_START_BATTERY_SOC'] || '0'),
      acChargeEndSOC: parseInt(allFields['HOLD_AC_CHARGE_END_BATTERY_SOC'] || '0'),
      acChargeStartVolt: parseFloat(allFields['HOLD_AC_CHARGE_START_BATTERY_VOLTAGE'] || '0'),
      acChargeEndVolt: parseFloat(allFields['HOLD_AC_CHARGE_END_BATTERY_VOLTAGE'] || '0'),
      peakShavingSOC1: parseInt(allFields['_12K_HOLD_GRID_PEAK_SHAVING_SOC'] || '0'),
      peakShavingSOC2: parseInt(allFields['_12K_HOLD_GRID_PEAK_SHAVING_SOC_2'] || '0'),
      peakShavingPower1: parseInt(allFields['_12K_HOLD_GRID_PEAK_SHAVING_POWER'] || '0'),
      peakShavingPower2: parseInt(allFields['_12K_HOLD_GRID_PEAK_SHAVING_POWER_2'] || '0'),
    };

    // Check enable flags
    const forcedChargeEnabled = allFields['FUNC_FORCED_CHG_EN'] === true || allFields['FUNC_FORCED_CHG_EN'] === 'true';
    const forcedDischargeEnabled = allFields['FUNC_FORCED_DISCHG_EN'] === true || allFields['FUNC_FORCED_DISCHG_EN'] === 'true';
    const backupEnabled = allFields['FUNC_BATTERY_BACKUP_CTRL'] === true || allFields['FUNC_BATTERY_BACKUP_CTRL'] === 'true';

    // Build the full schedule — fill gaps with Self Consumption
    // Only include modes that are enabled
    const modes = [];
    for (const slot of acCharge) modes.push({ mode: 'AC Charge', ...slot });
    if (peakEnabled) for (const slot of peakShaving) modes.push({ mode: 'Peak Shaving', ...slot });
    if (forcedChargeEnabled) for (const slot of forcedCharge) modes.push({ mode: 'Forced Charge', ...slot });
    if (forcedDischargeEnabled) for (const slot of forcedDischarge) modes.push({ mode: 'Forced Discharge', ...slot });

    // Sort by start time
    modes.sort((a, b) => a.start.localeCompare(b.start));

    // Fill gaps with Self Consumption
    const schedule = [];
    let cursor = '00:00';
    for (const m of modes) {
      if (m.start > cursor) {
        schedule.push({ mode: 'Self Consumption', start: cursor, end: m.start });
      }
      schedule.push(m);
      cursor = m.end;
    }
    if (cursor < '24:00' && cursor !== '00:00') {
      schedule.push({ mode: 'Self Consumption', start: cursor, end: '24:00' });
    }
    if (modes.length === 0) {
      schedule.push({ mode: 'Self Consumption', start: '00:00', end: '24:00' });
    }

    res.json({
      success: true,
      schedule,
      acCharge,
      peakShaving,
      peakShavingEnabled: peakEnabled,
      forcedCharge,
      forcedDischarge,
      batterySettings,
      firmware: allFields['HOLD_FW_CODE'] || null,
      deviceTime: allFields['HOLD_TIME'] || null,
    });
  } catch (err) {
    console.error('Working modes error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/eg4/read-settings
app.get('/api/eg4/read-settings', async (req, res) => {
  if (!isSessionValid()) return res.status(401).json({ error: 'Not authenticated' });
  if (!currentSerialNum) return res.status(400).json({ error: 'No station selected' });

  try {
    const [runtimeRes, configRes] = await Promise.all([
      fetch(`${EG4_BASE_URL}/api/inverter/getInverterRuntime?serialNum=${currentSerialNum}`, {
        headers: { 'Cookie': sessionCookie }
      }),
      fetch(`${EG4_BASE_URL}/api/inverter/getSystemConfigInfo?serialNum=${currentSerialNum}`, {
        headers: { 'Cookie': sessionCookie }
      })
    ]);

    const runtime = await runtimeRes.json();
    const config = await configRes.json();
    res.json({ success: true, runtime: runtime.data, config: config.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/eg4/set-working-mode
app.post('/api/eg4/set-working-mode', async (req, res) => {
  if (!isSessionValid()) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const response = await fetch(`${EG4_BASE_URL}/api/inverter/setWorkingMode`, {
      method: 'POST',
      headers: { 'Cookie': sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, serialNum: currentSerialNum })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/eg4/set-ac-charge
app.post('/api/eg4/set-ac-charge', async (req, res) => {
  if (!isSessionValid()) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const response = await fetch(`${EG4_BASE_URL}/api/inverter/setAcChargeConfig`, {
      method: 'POST',
      headers: { 'Cookie': sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, serialNum: currentSerialNum })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/eg4/set-peak-shaving
app.post('/api/eg4/set-peak-shaving', async (req, res) => {
  if (!isSessionValid()) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const response = await fetch(`${EG4_BASE_URL}/api/inverter/setPeakShavingConfig`, {
      method: 'POST',
      headers: { 'Cookie': sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, serialNum: currentSerialNum })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/eg4/set-battery-settings
app.post('/api/eg4/set-battery-settings', async (req, res) => {
  if (!isSessionValid()) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const response = await fetch(`${EG4_BASE_URL}/api/inverter/setBatteryConfig`, {
      method: 'POST',
      headers: { 'Cookie': sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req.body, serialNum: currentSerialNum })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/eg4/realtime - Get real-time inverter runtime data (power, SOC, voltages, etc.)
app.get('/api/eg4/realtime', async (req, res) => {
  if (!isSessionValid() || !currentSerialNum) {
    return res.json({ success: false, error: 'Not connected to EG4' });
  }
  try {
    // Fetch both runtime and energy data in parallel
    const [runtimeRes, energyRes] = await Promise.all([
      fetch(`${EG4_BASE_URL}/api/inverter/getInverterRuntime`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': sessionCookie },
        body: `serialNum=${currentSerialNum}`
      }),
      fetch(`${EG4_BASE_URL}/api/inverter/getInverterEnergyInfo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': sessionCookie },
        body: `serialNum=${currentSerialNum}`
      })
    ]);
    const runtime = await runtimeRes.json();
    const energy = await energyRes.json();

    // Compute consumption: solar + grid_import + battery_discharge - grid_export - battery_charge
    // ppv = total PV watts, pToUser = grid import, pToGrid = grid export, pCharge = battery charge, pDisCharge = battery discharge
    const pvPower = (runtime.ppv || 0) / 10; // EG4 returns in 0.1W units? Check...
    // Actually EG4 returns raw watts for ppv, pCharge, pDisCharge, pToGrid, pToUser
    const solarW = runtime.ppv || 0;
    const battChargeW = runtime.pCharge || 0;
    const battDischargeW = runtime.pDisCharge || 0;
    const gridImportW = runtime.pToUser || 0;
    const gridExportW = runtime.pToGrid || 0;
    const consumptionW = solarW + gridImportW + battDischargeW - gridExportW - battChargeW;

    res.json({
      success: true,
      // Real-time power (watts)
      solarPower: solarW,
      batteryPower: runtime.batPower || 0,
      batteryCharging: battChargeW,
      batteryDischarging: battDischargeW,
      gridImport: gridImportW,
      gridExport: gridExportW,
      consumptionPower: Math.max(0, consumptionW),
      inverterPower: runtime.pinv || 0,
      epsPower: runtime.peps || 0,
      // PV string details
      pv1Power: runtime.ppv1 || 0,
      pv2Power: runtime.ppv2 || 0,
      pv3Power: runtime.ppv3 || 0,
      pv1Voltage: (runtime.vpv1 || 0) / 10,
      pv2Voltage: (runtime.vpv2 || 0) / 10,
      pv3Voltage: (runtime.vpv3 || 0) / 10,
      // Battery
      soc: runtime.soc || 0,
      batteryVoltage: (runtime.vBat || 0) / 10,
      batteryTemp: runtime.tBat || 0,
      // Grid
      gridVoltage: (runtime.vacr || 0) / 10,
      gridFrequency: (runtime.fac || 0) / 100,
      // Status
      statusText: runtime.statusText || 'unknown',
      deviceTime: runtime.deviceTime || null,
      lost: runtime.lost || false,
      hasRuntimeData: runtime.hasRuntimeData || false,
      // Working mode from runtime
      workModeText: runtime.workModeText || null,
      // Energy totals (today)
      todaySolarYield: energy.todayYieldingText || '0',
      todayBatteryDischarge: energy.todayDischargingText || '0',
      todayBatteryCharge: energy.todayChargingText || '0',
      todayGridImport: energy.todayImportText || '0',
      todayGridExport: energy.todayExportText || '0',
      todayConsumption: energy.todayUsageText || '0',
      // BMS info
      bmsCharge: runtime.bmsCharge,
      bmsDischarge: runtime.bmsDischarge,
      bmsForceCharge: runtime.bmsForceCharge,
      maxChargeCurrent: (runtime.maxChgCurrValue || 0),
      maxDischargeCurrent: (runtime.maxDischgCurrValue || 0),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'EG4 Proxy Server running', connected: isSessionValid(), serialNum: currentSerialNum });
});

app.listen(PORT, () => {
  console.log(`EG4 Proxy Server running on port ${PORT}`);
});
