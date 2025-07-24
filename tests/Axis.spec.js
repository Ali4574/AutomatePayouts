import { test, chromium, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { sendTelegramAlert } from '../utils/sendTelegram.js';

// --- CONFIGURATION ---
const DOWNLOAD_DIR = 'tests/KotakFiles';
const sampleFilesDir = path.resolve(DOWNLOAD_DIR);

// Account credentials
const AXIS_ACCOUNT = {
    corporateId: process.env.AXIS_CORPORATE_ID,
    loginId: process.env.AXIS_LOGIN_ID,
    password: process.env.AXIS_PASSWORD,
};

// --- HELPER FUNCTIONS ---

/**
 * Cleans up old Excel files from the download directory.
 */
async function cleanupOldFiles() {
    if (!fs.existsSync(DOWNLOAD_DIR)) {
        fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    }
    const files = fs.readdirSync(DOWNLOAD_DIR);
    for (const f of files) {
        if (f.endsWith('.xlsx') || f.endsWith('.xls') || f.endsWith('.csv')) {
            fs.unlinkSync(path.join(DOWNLOAD_DIR, f));
        }
    }
    console.log('🧹 Old files removed');
}

/**
 * Finds and returns the name of the most recently modified file with a given extension.
 */
function getLatestFile(directory, extension) {
    const files = fs.readdirSync(directory);
    const recentFile = files
        .filter(file => path.extname(file).toLowerCase() === extension.toLowerCase())
        .map(file => ({
            file,
            time: fs.statSync(path.join(directory, file)).mtime.getTime(),
        }))
        .sort((a, b) => b.time - a.time)[0];

    if (!recentFile) {
        throw new Error(`❌ No files with extension ${extension} found in ${directory}`);
    }

    console.log(`✅ Automatically selected latest file: ${recentFile.file}`);
    return recentFile.file;
}


// --- TELEGRAM ALERT ON FAILURE ---
test.afterEach(async ({ }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
        const title = testInfo.title;
        const error = testInfo.error;

        let messageToSend = `❗ *Axis Bank Test Failed: ${title}*`;

        if (error?.message) {
            messageToSend += `\n\`\`\`${error.message.replace(/`/g, '')}\`\`\``;
        } else if (testInfo.status === 'timedOut') {
            messageToSend += `\n\`\`\`Test timed out after ${testInfo.timeout}ms.\`\`\``;
        } else if (testInfo.status === 'interrupted') {
            messageToSend += `\n\`\`\`Test was interrupted\`\`\``;
        } else {
            messageToSend += `\n\`\`\`Unknown failure. Status: ${testInfo.status}\`\`\``;
        }

        await sendTelegramAlert(messageToSend);
    }
});

// --- MAIN TEST SCRIPT ---
test('🏦 Axis Bank: Upload Excel File & Process Payments', async ({ page }) => {
    test.setTimeout(600000); // 10 minutes timeout

    let currentStep = 'START';

    try {
        // =================================================================
        // PART 1: CLEANUP AND PREPARE FILES
        // =================================================================
        console.log('--- PART 1: CLEANING UP OLD FILES ---');
        // await cleanupOldFiles();

        // Check if there are any Excel files in the directory to upload
        const excelFiles = fs.readdirSync(sampleFilesDir).filter(file =>
            file.endsWith('.xlsx') || file.endsWith('.xls')
        );

        if (excelFiles.length === 0) {
            console.log('⚠️ No Excel files found in directory. Please add Excel files to upload.');
            await sendTelegramAlert('⚠️ *Axis Bank Test*\n```No Excel files found in directory for upload```');
            return;
        }

        console.log(`✅ Found ${excelFiles.length} Excel file(s) ready for upload.`);

        // =================================================================
        // PART 2: LOGIN AND FILE UPLOAD TO AXIS BANK
        // =================================================================
        console.log('\n--- PART 2: AXIS BANK LOGIN & FILE UPLOAD ---');

        currentStep = 'Browser Launch';

        // Login Process
        currentStep = 'Navigate to Login Page';
        await page.goto('https://gtb1.axisbank.com/pre-login-interim', {
            waitUntil: 'networkidle',
            timeout: 60000
        });

        currentStep = 'Enter Corporate ID';
        await page.getByRole('textbox', { name: 'Corporate ID*' }).click();
        await page.getByRole('textbox', { name: 'Corporate ID*' }).fill(AXIS_ACCOUNT.corporateId);
        await page.waitForTimeout(1000);

        await page.getByRole('textbox', { name: 'Login ID*' }).click();
        await page.getByRole('textbox', { name: 'Login ID*' }).fill(AXIS_ACCOUNT.loginId);
        await page.waitForTimeout(1000);

        await page.getByRole('button', { name: 'Proceed' }).click();
        await page.waitForTimeout(3000);

        currentStep = 'Enter Password';
        await page.getByRole('textbox', { name: 'Password*' }).click();
        await page.getByRole('textbox', { name: 'Password*' }).fill(AXIS_ACCOUNT.password);
        await page.waitForTimeout(1000);

        await page.getByRole('button', { name: 'Proceed' }).click();
        await page.waitForTimeout(3000);

        // Manual OTP Entry
        currentStep = 'Manual OTP Entry';
        console.log('\n🔒 Paused for manual OTP entry and Submit. Resume when ready.');
        await page.pause();

        // Navigate to Payments
        currentStep = 'Navigate to Payments';
        await page.getByRole('button', { name: 'Payments' }).click();
        await page.waitForTimeout(2000);

        await page.getByText('New Payments').first().click();
        await page.waitForTimeout(2000);

        await page.getByRole('button', { name: 'Vendor Payments' }).first().click();
        await page.waitForTimeout(2000);

        await page.getByRole('tab', { name: 'Bulk Payment' }).click();
        await page.waitForTimeout(2000);

        // Select payment type
        currentStep = 'Configure Bulk Payment';
        await page.getByRole('radio', { name: 'Across All Banks' }).check();
        await page.waitForTimeout(1000);

        await page.locator('div').filter({ hasText: /^Admin BulkXLSXCUSTOM$/ }).first().click();
        await page.waitForTimeout(2000);

        // File Upload
        currentStep = 'File Upload';
        const latestExcelFile = getLatestFile(sampleFilesDir, '.xlsx');
        const filePath = path.join(sampleFilesDir, latestExcelFile);

        console.log(`📁 Uploading file: ${latestExcelFile}`);

        const [fileChooser] = await Promise.all([
            page.waitForEvent('filechooser'),
            page.$eval('input[type="file"]', input => input.click()),
        ]);
        await fileChooser.setFiles(filePath);
        await page.waitForTimeout(3000);

        await page.getByRole('button', { name: 'Proceed' }).click();
        await page.waitForTimeout(5000);

        // Wait for validation
        currentStep = 'File Validation';
        await expect(page.getByText('Validation Completed')).toBeVisible({ timeout: 60000 });
        console.log('✅ File validation completed');

        await page.getByRole('button', { name: 'Proceed' }).click();
        await page.waitForTimeout(3000);

        await page.getByRole('button', { name: 'Make Payment' }).click();
        await page.waitForTimeout(3000);

        // Payment OTP
        currentStep = 'Payment OTP';
        console.log('\n🔒 Paused for manual OTP entry and Submit. Resume when ready.');
        await page.pause();

        // Verify success
        currentStep = 'Payment Verification';
        try {
            await expect(page.locator('div').filter({ hasText: /^Fund transfer successful$/ })).toBeVisible({ timeout: 30000 });
            console.log('✅ Payment processed successfully!');

            await sendTelegramAlert(`✅ *Axis Bank Payment Success*\n📄 File: ${latestExcelFile}\n💰 Payments processed successfully`);

        } catch (error) {
            console.log('⚠️ Success message not found, checking for other indicators...');
            await sendTelegramAlert(`❌ *Something went wrong with the payment process. Please check the file and try again.*\n📄 File: ${latestExcelFile}`);
        }

        await page.getByRole('button', { name: 'Back to Payment Overview' }).click();
        await page.waitForTimeout(3000);

        console.log('🎉 Axis Bank automation completed successfully!');
        

    } catch (error) {
        console.error(`❌ Error in step '${currentStep}':`, error);
        const alertMessage = `❌ *Axis Bank Automation Failed*\n🔍 Step: ${currentStep}\n🧨 Error: ${error.message}`;
        await sendTelegramAlert(alertMessage);
        throw error;
    }
});