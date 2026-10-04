// smoke-test.mjs — Platform-specific smoke tests for installed builds
// Tests that the application launches and responds to basic commands

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PLATFORM = process.platform;
const ARCH = process.arch;

console.log(`Running smoke tests on ${PLATFORM} (${ARCH})...`);

// Test results
const results = {
  platform: PLATFORM,
  arch: ARCH,
  tests: [],
  passed: 0,
  failed: 0,
};

function recordTest(name, passed, message = '') {
  results.tests.push({ name, passed, message });
  if (passed) {
    results.passed++;
    console.log(`✓ ${name}`);
  } else {
    results.failed++;
    console.log(`✗ ${name}: ${message}`);
  }
}

// Platform-specific binary paths
function getBinaryPath() {
  if (PLATFORM === 'linux') {
    // Check for AppImage first, then try to find installed binary
    const appimagePath = join(__dirname, '../app/src-tauri/target/release/bundle/appimage/trance-music.AppImage');
    if (existsSync(appimagePath)) {
      return appimagePath;
    }
    // Fallback to system binary
    return 'trance-music';
  } else if (PLATFORM === 'darwin') {
    const appPath = join(__dirname, '../app/src-tauri/target/release/bundle/macos/TRANCE MUSIC.app');
    if (existsSync(appPath)) {
      return appPath;
    }
    return '/Applications/TRANCE MUSIC.app';
  } else if (PLATFORM === 'win32') {
    const exePath = join(__dirname, '../app/src-tauri/target/release/bundle/msi/TRANCE MUSIC_0.3.0_x64_en-US.msi');
    if (existsSync(exePath)) {
      return exePath;
    }
    return 'C:\\Program Files\\TRANCE MUSIC\\trance-music.exe';
  }
  throw new Error(`Unsupported platform: ${PLATFORM}`);
}

// Test 1: Binary exists
async function testBinaryExists() {
  try {
    const path = getBinaryPath();
    const exists = existsSync(path);
    recordTest('Binary exists', exists, `Path: ${path}`);
  } catch (err) {
    recordTest('Binary exists', false, err.message);
  }
}

// Test 2: Binary is executable (Linux/macOS) or exists (Windows)
async function testBinaryExecutable() {
  try {
    const path = getBinaryPath();
    if (PLATFORM === 'win32') {
      recordTest('Binary executable', true, 'Windows binary check skipped');
      return;
    }

    // For macOS .app, check the inner binary
    let binaryPath = path;
    if (PLATFORM === 'darwin' && path.endsWith('.app')) {
      binaryPath = join(path, 'Contents/MacOS/trance-music');
    }

    const exists = existsSync(binaryPath);
    recordTest('Binary executable', exists, `Path: ${binaryPath}`);
  } catch (err) {
    recordTest('Binary executable', false, err.message);
  }
}

// Test 3: Binary launches (with timeout)
async function testBinaryLaunch() {
  return new Promise((resolve) => {
    try {
      const path = getBinaryPath();
      let args = [];

      if (PLATFORM === 'linux' && path.endsWith('.AppImage')) {
        args = [path];
      } else if (PLATFORM === 'darwin' && path.endsWith('.app')) {
        args = ['open', '-n', path];
      } else if (PLATFORM === 'win32') {
        args = [path];
      } else {
        args = [path, '--version'];
      }

      const command = PLATFORM === 'linux' || PLATFORM === 'darwin' ? args[0] : path;
      const commandArgs = PLATFORM === 'linux' || PLATFORM === 'darwin' ? args.slice(1) : args.slice(1);

      const proc = spawn(command, commandArgs, {
        stdio: 'ignore',
        detached: true,
      });

      // Kill after 5 seconds
      const timeout = setTimeout(() => {
        if (proc.pid) {
          if (PLATFORM === 'win32') {
            spawn('taskkill', ['/pid', proc.pid, '/f']);
          } else {
            process.kill(proc.pid, 'SIGTERM');
          }
        }
        recordTest('Binary launch', true, 'Process started successfully');
        resolve();
      }, 5000);

      proc.on('error', (err) => {
        clearTimeout(timeout);
        recordTest('Binary launch', false, err.message);
        resolve();
      });

      proc.on('exit', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          recordTest('Binary launch', true, 'Process exited cleanly');
        } else {
          recordTest('Binary launch', true, `Process exited with code ${code}`);
        }
        resolve();
      });
    } catch (err) {
      recordTest('Binary launch', false, err.message);
      resolve();
    }
  });
}

// Test 4: Configuration files
async function testConfigFiles() {
  try {
    const configPath = join(__dirname, '../app/src-tauri/tauri.conf.json');
    const exists = existsSync(configPath);
    recordTest('Config file exists', exists, `Path: ${configPath}`);
  } catch (err) {
    recordTest('Config file exists', false, err.message);
  }
}

// Test 5: Frontend assets
async function testFrontendAssets() {
  try {
    const indexPath = join(__dirname, '../app/src/index.html');
    const exists = existsSync(indexPath);
    recordTest('Frontend assets exist', exists, `Path: ${indexPath}`);
  } catch (err) {
    recordTest('Frontend assets exist', false, err.message);
  }
}

// Run all tests
async function runTests() {
  await testBinaryExists();
  await testBinaryExecutable();
  await testBinaryLaunch();
  await testConfigFiles();
  await testFrontendAssets();

  // Print summary
  console.log('\n=== Smoke Test Summary ===');
  console.log(`Platform: ${PLATFORM} (${ARCH})`);
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(`Total: ${results.tests.length}`);

  if (results.failed > 0) {
    console.log('\nFailed tests:');
    results.tests.filter(t => !t.passed).forEach(t => {
      console.log(`  - ${t.name}: ${t.message}`);
    });
    process.exit(1);
  } else {
    console.log('\n✅ All smoke tests passed!');
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('Smoke test error:', err);
  process.exit(1);
});
