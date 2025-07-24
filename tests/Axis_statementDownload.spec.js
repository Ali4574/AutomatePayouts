// axis-report-download.spec.js
import { test, expect, chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import xlsx from 'xlsx';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';
import { sendTelegramAlert } from '../utils/sendTelegram.js';

dotenv.config();

const DOWNLOAD_DIR = path.resolve('tests/kotakReports');
const MONGO_URI = process.env.MONGODB_URI || '';
const MONGO_DB = process.env.MONGO_DB || 'Paylogic';
const MONGO_COLL = process.env.MONGO_COLL || 'axis_reports';

const AXIS_ACCOUNT = {
    corporateId: process.env.AXIS_CORPORATE_ID,
    loginId: process.env.AXIS_LOGIN_ID,
    password: process.env.AXIS_PASSWORD,
};

/**
 * Parses the downloaded Axis Bank XLS report to extract transaction data.
 * @param {string} filePath - The path to the XLS file.
 * @returns {Array<Object>} An array of transaction documents.
 */
function parseAxisBankReport(filePath) {
    try {
        // --- 1. Read Excel File ---
        const workbook = xlsx.readFile(filePath);
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        console.log(`📖 Reading data from sheet: "${sheetName}"`);

        // --- 2. Define Stop Markers and Extract Data ---
        const stopMarkers = [
            'payment type summary',
            'payment method wise summary',
            'note: unless the constituent',
        ];

        // Read all rows starting from row 16 (0-indexed)
        const allRows = xlsx.utils.sheet_to_json(sheet, {
            range: 15,
            defval: '',
            raw: false,
        });

        console.log(`\n📊 Found ${allRows.length} potential transaction rows.`);

        const results = [];
        for (const row of allRows) {
            // Convert all values in the row to a single lowercase string
            const rowAsText = Object.values(row).join(' ').toLowerCase();

            // Stop processing if a summary section is found
            if (stopMarkers.some(marker => rowAsText.includes(marker))) {
                console.log(`\n🛑 Stop marker found. Halting processing.`);
                break;
            }

            // Skip empty rows or rows without essential data
            if (!row['Transaction Date'] || !row['Beneficiary Name']) {
                continue;
            }

            // Map and clean the data for database insertion
            results.push({
                Serial_No: row['S. No.'] || '',
                Transaction_Date: row['Transaction Date'] || '',
                Beneficiary_Name: row['Beneficiary Name'] || '',
                Beneficiary_Account_Number: row['Beneficiary Account Number'] || '',
                Beneficiary_Bank: row['Beneficiary Bank'] || '',
                Beneficiary_IFSC: row['Beneficiary IFSC'] || '',
                Amount: typeof row['Amount'] === 'string'
                    ? parseFloat(row['Amount'].replace(/[^0-9.-]+/g, ''))
                    : row['Amount'] || null,
                UTR: row['UTR'] || '',
                CRN: row['CRN'] || '',
                File_Name: row['File Name'] || '',
                Status: row['Status'] || '',
                Payment_Mode: row['Payment Mode'] || '',
                fetchedAt: new Date(),
            });
        }

        console.log(`\n✅ Successfully extracted ${results.length} valid records.`);
        return results;

    } catch (error) {
        console.error('❌ Error parsing file:', error.message);
        return []; // Return an empty array on failure
    }
}

test('📊 Axis Bank: Download and Save Reports to MongoDB', async () => {
    test.setTimeout(300000);
    let browser, client;
    let step = 'Start';

    try {
        browser = await chromium.launch({ headless: false });
        const context = await browser.newContext();
        const page = await context.newPage();

        // MongoDB connection
        step = 'MongoDB Connection';
        client = new MongoClient(MONGO_URI);
        await client.connect();
        const collection = client.db(MONGO_DB).collection(MONGO_COLL);

        // Login to Axis
        step = 'Login to Axis Bank';
        await page.goto('https://gtb1.axisbank.com/pre-login-interim', { waitUntil: 'networkidle' });
        await page.getByRole('textbox', { name: 'Corporate ID*' }).fill(AXIS_ACCOUNT.corporateId);
        await page.waitForTimeout(2000);

        await page.getByRole('textbox', { name: 'Login ID*' }).fill(AXIS_ACCOUNT.loginId);
        await page.waitForTimeout(2000);
        await page.getByRole('button', { name: 'Proceed' }).click();
        await page.waitForTimeout(2000);
        await page.getByRole('textbox', { name: 'Password*' }).fill(AXIS_ACCOUNT.password);
        await page.waitForTimeout(1000);
        await page.getByRole('button', { name: 'Proceed' }).click();

        // Manual OTP Entry
        step = 'Manual OTP';
        console.log('\n🔒 Paused for manual OTP entry and Submit. Resume when ready.');
        await page.pause();

        // Generate Report
        step = 'Generate Report';
        await page.getByRole('button', { name: 'Reports' }).click();
        await page.waitForTimeout(2000);
        await page.getByText('Transaction Analysis Report').click();
        await page.waitForTimeout(2000);
        await page.getByRole('radio', { name: 'Admin Report' }).check();
        await page.waitForTimeout(2000);
        await page.getByRole('button', { name: /Choose date/ }).first().click();
        await page.getByRole('gridcell', { name: '1', exact: true }).click();
        await page.waitForTimeout(2000);
        await page.getByRole('button', { name: /Choose date/ }).nth(1).click();
        await page.getByRole('gridcell', { name: '22' }).click();
        await page.waitForTimeout(2000);
        await page.getByRole('button', { name: 'Generate Report' }).click();
        await page.waitForTimeout(5000);

        // Download report
        step = 'Download Report';
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.getByRole('button', { name: 'Download All' }).click(),
            page.locator('div').filter({ hasText: /^XLS$/ }).click(),
        ]);

        const safeDate = new Date().toISOString().split('T')[0];
        const fileName = `axis_report_${safeDate}.xls`;
        const filePath = path.join(DOWNLOAD_DIR, fileName);
        await download.saveAs(filePath);
        console.log(`✅ Report saved: ${filePath}`);

        // Parse XLS with custom parser and save to MongoDB
        step = 'Parse and Save to MongoDB';
        const docs = parseAxisBankReport(filePath);

        if (docs.length > 0) {
            await collection.insertMany(docs);
            console.log(`💾 Inserted ${docs.length} records into MongoDB`);

            // Delete the XLS file to save space
            try {
                fs.unlinkSync(filePath);
                console.log(`🗑️ Deleted XLS file: ${filePath}`);
            } catch (err) {
                console.warn(`⚠️ Failed to delete file ${filePath}:`, err.message);
            }
        } else {
            console.log('⚠️ No records parsed from XLS');
        }

        await sendTelegramAlert(`📊 *Axis Report Downloaded & Saved*
✅ File: ${fileName}
🧾 Records: ${docs.length}`);
    } catch (err) {
        console.error(`❌ Failed at step: ${step}`);
        console.error(err);
        await sendTelegramAlert(`❌ *Axis Report Download Failed*
🔍 Step: ${step}
🧨 Error: ${err.message}`);
        throw err;
    } finally {
        if (client) await client.close();
        if (browser) await browser.close();
    }
});