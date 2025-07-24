import { test, chromium, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fetchLatestOtp } from '../utils/fetchOtp.js';
import { sendTelegramAlert } from '../utils/sendTelegram.js';
import { MongoClient } from 'mongodb'; // <-- Added for MongoDB
import Papa from 'papaparse'; // <-- Added for CSV generation
import dotenv from 'dotenv';
dotenv.config({
    path: '../.env', // <-- Ensure this points to your .env files
});

// --- CONFIGURATION ---
const DOWNLOAD_DIR = 'tests/KotakFiles';
const sampleFilesDir = path.resolve(DOWNLOAD_DIR);

const MONGO_URI = process.env.MONGODB_URI || ''; // <-- IMPORTANT: Add your MongoDB connection string
const MONGO_DB = process.env.MONGO_DB || 'Paylogic'; // <-- Add your database name
const MONGO_COLL = process.env.MONGO_COLL || 'payouts'; // <-- Add your payouts collection name

// Account details for upload (A) and approval (B)
const ACCOUNT_A_DETAILS = {
    crn: process.env.KOTAK_CRN_A, 
    password: process.env.KOTAK_PASSWORD_A, //
};

const ACCOUNT_B = {
    crn: process.env.KOTAK_CRN_B, 
    password: process.env.KOTAK_PASSWORD_B, 
};


// --- HELPER FUNCTIONS ---

/**
 * Cleans up old CSV, XLS, and XLSX files from the download directory.
 */
async function cleanupOldFiles() {
    if (!fs.existsSync(DOWNLOAD_DIR)) {
        fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    }
    // Only clean up non-CSV files or very old CSV files (optional)
    const files = fs.readdirSync(DOWNLOAD_DIR);
    for (const f of files) {
        if (f.endsWith('.xls') || f.endsWith('.xlsx')) {
            fs.unlinkSync(path.join(DOWNLOAD_DIR, f));
        }
    }
    console.log('🧹 Old non-CSV files removed');
}

/**
 * Finds and returns the name of the most recently modified file with a given extension.
 * @param {string} directory - The directory to search in.
 * @param {string} extension - The file extension to look for (e.g., '.csv').
 * @returns {string} The filename of the latest file.
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

/**
 * Checks if there are any existing CSV files in the directory
 * @param {string} directory - The directory to check
 * @returns {boolean} True if CSV files exist
 */
function hasExistingCsvFiles(directory) {
    if (!fs.existsSync(directory)) {
        return false;
    }
    const files = fs.readdirSync(directory);
    return files.some(file => file.endsWith('.csv'));
}

/**
 * Deletes the specified file
 * @param {string} filePath - Full path to the file to delete
 */
function deleteFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Successfully deleted file: ${path.basename(filePath)}`);
        }
    } catch (error) {
        console.error(`❌ Failed to delete file: ${filePath}`, error);
    }
}

// --- TELEGRAM ALERT ON FAILURE ---
test.afterEach(async ({ }, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) {
        const title = testInfo.title;
        const error = testInfo.error;

        let messageToSend = `❗ *${title}*`;

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
test('🔁 Full Cycle: Admin Download -> Kotak Upload & Approve', async ({ page }) => {
    // Set a long timeout for the entire sequence
    test.setTimeout(500000);

    let csvFilePath = null;
    let csvFileName = null;
    let shouldUpdateDatabase = false;
    let payoutIds = [];

    // =================================================================
    // PART 1: CHECK FOR EXISTING CSV OR GENERATE NEW ONE
    // =================================================================
    console.log('--- PART 1: CHECKING FOR EXISTING CSV OR GENERATING NEW ONE ---');
    await cleanupOldFiles();

    // Check if there are existing CSV files
    if (hasExistingCsvFiles(sampleFilesDir)) {
        console.log('📁 Found existing CSV file(s) in directory');
        csvFileName = getLatestFile(sampleFilesDir, '.csv');
        csvFilePath = path.join(sampleFilesDir, csvFileName);
        console.log(`🔄 Using existing CSV file: ${csvFileName}`);
        shouldUpdateDatabase = false; // Don't update DB since this is a retry
    } else {
        console.log('📄 No existing CSV files found. Generating new CSV from database...');
        
        const client = new MongoClient(MONGO_URI);
        let csvGenerated = false;

        try {
            await client.connect();
            console.log('🔗 Connected to MongoDB successfully.');
            const db = client.db(MONGO_DB);
            const payoutsCollection = db.collection(MONGO_COLL);

            // Find the 100 oldest "processing" payouts
            const payouts = await payoutsCollection.find({ status: "processing" })
                .sort({ createdAt: 1 }) // 1 for ascending (oldest first)
                .limit(100)
                .toArray();

            if (!payouts.length) {
                console.log('⚠️ No processing payouts found in DB. Stopping test.');
                return; // Exit the test if no data is found
            }
            console.log(`✅ Found ${payouts.length} processing payouts.`);

            // Store payout IDs for later database update
            payoutIds = payouts.map(p => p._id);
            shouldUpdateDatabase = true;

            // Format payout data for Kotak CSV
            const formattedData = payouts.map((item) => ({
                "Client Code": "TTPL7",
                "Product Code": "VPAY",
                "Payment Type": "IMPS",
                "payout_id": item.payoutId || "",
                "date": new Date().toLocaleDateString("en-GB"),
                " ": "",
                "Dr Ac No": "3250499167",
                "Ammount": item.amount.toFixed(2),
                "Bank Code Indicator": "KKBK0000660",
                "  ": "", // Note: different spacing from original to create distinct columns
                "Beneficiary Name": item.beneficiary?.name || "",
                "   ": "", // Note: different spacing
                "IFSC": item.beneficiary?.ifsc || "",
                "Account No.": item.beneficiary?.account || "",
            }));

            // Generate CSV string
            const csv = Papa.unparse(formattedData, { header: false });

            // Create a unique filename
            const now = new Date();
            csvFileName = `${now.getDate().toString().padStart(2, "0")}_${(now.getMonth() + 1).toString().padStart(2, "0")}_${now.getFullYear()}_${now.getHours().toString().padStart(2, "0")}_${now.getMinutes().toString().padStart(2, "0")}.csv`;
            csvFilePath = path.join(DOWNLOAD_DIR, csvFileName);

            // Save the CSV file
            fs.writeFileSync(csvFilePath, csv);
            console.log(`✅ CSV file generated successfully: ${csvFilePath}`);
            csvGenerated = true;

        } catch (error) {
            console.error('❌ Error during DB operation or CSV generation:', error);
            await sendTelegramAlert(`❌ *DB/CSV Generation Failed*\n\`\`\`${error.message}\`\`\``);
            throw error; // Fail the test
        } finally {
            await client.close();
            console.log('🔌 MongoDB connection closed.');
        }

        if (!csvGenerated) {
            console.log("Stopping test because CSV file was not generated.");
            return;
        }
    }

    // =================================================================
    // PART 2: UPLOAD AND APPROVE IN KOTAK NETBANKING
    // =================================================================
    console.log('\n--- PART 2: UPLOADING AND APPROVING FILE ---');

    const ACCOUNT_A = { ...ACCOUNT_A_DETAILS, fileToUpload: csvFileName };

    const browser = await chromium.launch({ channel: 'chrome'});
    let currentStep = 'START';
    let contextA, pageA;

    try {
        // ========== ACCOUNT A: FILE UPLOAD ==========
        currentStep = 'Login Account A';
        contextA = await browser.newContext();
        pageA = await contextA.newPage();
        await pageA.goto('https://netbanking.kotak.com/knb2/');
        await pageA.getByRole('textbox', { name: 'CRN, Username or Card Number' }).fill(ACCOUNT_A.crn);
        await pageA.waitForTimeout(2000);
        await pageA.getByRole('textbox', { name: 'Password' }).fill(ACCOUNT_A.password);
        await pageA.waitForTimeout(2000);
        await pageA.getByRole('button', { name: 'Secure login' }).click();

        // OTP for Account A
        currentStep = 'OTP A';
        const startTimeA = Date.now();
        let otpA = null;
        while (!otpA && Date.now() - startTimeA < 60000) {
            otpA = await fetchLatestOtp(startTimeA);
            if (!otpA) await new Promise(r => setTimeout(r, 3000));
        }
        if (!otpA) throw new Error('❌ OTP A timeout');
        console.log('✅ OTP A:', otpA);

        await pageA.getByRole('textbox', { name: 'otpMobile' }).fill(otpA);
        await pageA.waitForTimeout(2000);
        await pageA.getByRole('button', { name: 'Secure login' }).click();
        await pageA.waitForTimeout(3000);
        await pageA.getByText('CMS NetIT-New').click();

        // Navigate to upload page
        currentStep = 'File Upload Page';
        const frameA = await pageA.frameLocator('iframe[name="knb2ContainerFrame"]');
        await pageA.waitForTimeout(2000);
        await frameA.getByRole('link', { name: 'Payments' }).click();
        await frameA.getByRole('link', { name: 'File Upload' }).click();
        await pageA.waitForTimeout(2000);
        await frameA.getByRole('button', { name: 'File Upload' }).click();
        await pageA.waitForTimeout(2000);
        await frameA.locator('#clientMapCode-niceSelect').getByText('Select').click();
        await frameA.getByRole('listitem', { name: /Payments.*EXCEL.*CSV.*UPLOAD/i }).click();
        await pageA.waitForTimeout(2000);

        // Upload the file
        currentStep = 'File Selection';
        const [fileChooser] = await Promise.all([
            pageA.waitForEvent('filechooser'),
            frameA.getByRole('button', { name: 'Select File' }).click(),
        ]);
        await fileChooser.setFiles(csvFilePath);
        await frameA.getByRole('button', { name: 'Upload', exact: true }).click();
        console.log(`🚀 File '${csvFileName}' upload initiated.`);
        await pageA.waitForTimeout(10000);

        // Verify upload status
        currentStep = 'Upload Status Verification';
        await frameA.getByLabel('Refresh').click();
        await pageA.waitForTimeout(5000);
        await frameA.getByLabel('Refresh').click();
        await pageA.waitForTimeout(3000);
        await frameA.getByLabel('Refresh').click();

        const fileRow = frameA.getByRole('row').filter({ hasText: csvFileName });
        const remarksCell = fileRow.locator('td.x-grid-cell-col_tskslRemarks');
        const expectedStatusRegex = /File Uploaded Successfully|Rejected Records|Error/i;
        await expect(remarksCell).toHaveText(expectedStatusRegex, { timeout: 90000 });
        const finalRemarks = await remarksCell.innerText();
        console.log(`📋 Upload remark: "${finalRemarks}"`);

        if (finalRemarks.includes('File Uploaded Successfully') && !finalRemarks.includes('Rejected')) {
            console.log('✅ File fully uploaded. Proceeding to approval.');
        } else {
            const alertMsg = `⚠️ *Upload Issue Detected*\n📂 File: \`${csvFileName}\`\n📝 Remark: _${finalRemarks}`;
            await sendTelegramAlert(alertMsg);
            throw new Error('⛔ Approval skipped due to upload issue.');
        }

        // ========== ACCOUNT B: APPROVAL ==========
        currentStep = 'Login Account B';
        const contextB = await browser.newContext();
        const pageB = await contextB.newPage();
        await pageB.goto('https://netbanking.kotak.com/knb2/');
        await pageB.waitForTimeout(3000);
        await pageB.getByRole('textbox', { name: 'CRN, Username or Card Number' }).fill(ACCOUNT_B.crn);
        await pageB.waitForTimeout(2000);
        await pageB.getByRole('textbox', { name: 'Password' }).fill(ACCOUNT_B.password);
        await pageB.waitForTimeout(2000);
        await pageB.getByRole('button', { name: 'Secure login' }).click();
        await pageB.waitForTimeout(2000);

        // OTP for Account B
        currentStep = 'OTP B';
        const startTimeB = Date.now();
        let otpB = null;
        while (!otpB && Date.now() - startTimeB < 60000) {
            otpB = await fetchLatestOtp(startTimeB);
            if (!otpB) await new Promise(r => setTimeout(r, 3000));
        }
        if (!otpB) throw new Error('❌ OTP B timeout');
        console.log('✅ OTP B:', otpB);

        await pageB.getByRole('textbox', { name: 'otpMobile' }).fill(otpB);
        await pageB.waitForTimeout(2000);
        await pageB.getByRole('button', { name: 'Secure login' }).click();
        await pageB.waitForTimeout(3000);
        await pageB.getByText('CMS NetIT-New').click();

        // Approval flow
        currentStep = 'Approval Flow';
        const frameB = await pageB.frameLocator('iframe[name="knb2ContainerFrame"]');
        await pageB.waitForTimeout(2000);
        await frameB.getByRole('link', { name: 'Payments' }).click();
        await pageB.waitForTimeout(2000);
        await frameB.locator('#btnMore_0').click();
        await frameB.getByRole('link', { name: 'Approve' }).click();
        await pageB.waitForTimeout(2000);
        await frameB.getByRole('button', { name: 'Approve All' }).click();
        await pageB.waitForTimeout(2000);
        await frameB.getByRole('button', { name: 'Continue' }).click();

        // Final OTP for approval
        currentStep = 'Final OTP for Approval';
        const startTimeC = Date.now();
        let otpFinal = null;
        while (!otpFinal && Date.now() - startTimeC < 60000) {
            otpFinal = await fetchLatestOtp(startTimeC);
            if (!otpFinal) await new Promise(r => setTimeout(r, 3000));
        }
        if (!otpFinal) throw new Error('❌ Final OTP timeout');
        console.log('✅ OTP for approval:', otpFinal);

        const otpInput = frameB.locator('#AuthDialog-innerCt input#token');
        await otpInput.focus();
        await otpInput.fill(otpFinal);
        await pageB.waitForTimeout(2000);
        await frameB.getByRole('button', { name: 'Submit' }).click();
        await pageB.waitForTimeout(5000);

        // Final refresh on uploader page to confirm status
        await frameB.getByLabel('Refresh').click();
        await pageB.waitForTimeout(5000);
        await frameB.getByLabel('Refresh').click();

        console.log('✅ Upload and approval process completed successfully!');

        // =================================================================
        // PART 3: UPDATE DATABASE AND CLEANUP (ONLY ON SUCCESS)
        // =================================================================
        if (shouldUpdateDatabase && payoutIds.length > 0) {
            console.log('\n--- PART 3: UPDATING DATABASE STATUS ---');
            const client = new MongoClient(MONGO_URI);
            try {
                await client.connect();
                const db = client.db(MONGO_DB);
                const payoutsCollection = db.collection(MONGO_COLL);

                // Update the status of the processed payouts to "queued"
                const updateResult = await payoutsCollection.updateMany(
                    { _id: { $in: payoutIds } },
                    { $set: { status: "queued" } }
                );
                console.log(`✅ Updated ${updateResult.modifiedCount} payouts to 'queued' status.`);
            } catch (error) {
                console.error('❌ Error updating database:', error);
                await sendTelegramAlert(`❌ *DB Update Failed*\n\`\`\`${error.message}\`\`\``);
                // Don't throw here - the main process succeeded, just log the DB update failure
            } finally {
                await client.close();
            }
        }

        // Delete the CSV file only after successful completion
        if (csvFilePath) {
            deleteFile(csvFilePath);
        }

    } catch (err) {
        const alert = `❌ *Test Failed*\n🔍 Step: ${currentStep}\n🧨 Error: ${err.message}`;
        await sendTelegramAlert(alert);
        throw err; // Re-throw error to fail the test
    } finally {
        await browser.close();
    }
});