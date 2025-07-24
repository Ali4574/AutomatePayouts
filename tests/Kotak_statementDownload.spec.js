import { test } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import xlsx from 'xlsx';
import { MongoClient } from 'mongodb';
import { fetchLatestOtp } from '../utils/fetchOtp.js';
import { sendTelegramAlert } from '../utils/sendTelegram.js'; // added for alerts

test('Download all file records for today with pagination', async ({ page }) => {
  test.setTimeout(1000000);

  const manualDate = ''; // e.g., '2025-07-03' or leave blank for today
  const dateObj = manualDate ? new Date(manualDate) : new Date();
  const day = dateObj.getDate().toString();
  const dateStr = dateObj.toLocaleDateString('en-GB');
  console.log(`📅 Using date: ${dateStr}`);

  const MONGO_URI = process.env.MONGODB_URI || '';
  const MONGO_DB = process.env.MONGO_DB || 'Paylogic';
  const MONGO_COLL = process.env.MONGO_COLL || 'temppayouts';
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const collection = client.db(MONGO_DB).collection(MONGO_COLL);

  // Login
  await page.goto('https://netbanking.kotak.com/knb2/');
  await page.waitForTimeout(3000);
  await page.getByRole('textbox', { name: 'CRN, Username or Card Number' }).fill('932893553');
  await page.waitForTimeout(3000);
  await page.getByRole('textbox', { name: 'Password' }).fill('Dream11@');
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: 'Secure login' }).click();
  await page.waitForTimeout(3000);

  // ——— OTP ———
  const startTime = Date.now();
  let otp = null;
  while (!otp && Date.now() - startTime < 60000) {
    otp = await fetchLatestOtp(startTime);
    if (!otp) await new Promise(r => setTimeout(r, 3000));
  }
  if (!otp) throw new Error('OTP not received.');
  await page.getByRole('textbox', { name: 'otpMobile' }).fill(otp);
  await page.waitForTimeout(3000);
  await page.getByRole('button', { name: 'Secure login' }).click();
  await page.waitForTimeout(3000);

  // ——— Navigate to Payment Center ———
  await page.getByText('CMS NetIT-New').click();
  await page.waitForTimeout(3000);
  const frame = page.frameLocator('iframe[name="knb2ContainerFrame"]');
  await frame.getByRole('link', { name: 'Payments' }).click();
  await frame.getByRole('link', { name: 'Payment Center' }).click();
  await page.waitForTimeout(3000);

  // ——— Apply filters ———
  await frame.locator('#tool-1074').click();
  await frame.getByPlaceholder('All').click();
  await frame.locator('#uncheckAllLink').click();
  await page.waitForTimeout(1000);
  await frame.getByRole('option', { name: 'Processed' }).locator('span').click();
  await frame.locator('#component-1047').click();
  await page.waitForTimeout(3000);
  await frame.getByRole('link', { name: day, exact: true }).click();
  await page.waitForTimeout(3000);
  await frame.getByRole('button', { name: 'View' }).click();
  await page.waitForTimeout(500);
  await frame.getByRole('link', { name: '100' }).click();
  await page.waitForTimeout(2000);

  // ——— Outer pagination: File list ———
  let pageIndex = 1;
  let hasNextPage = true;

  while (hasNextPage) {
    const fileRows = frame.locator('#gridview-1102-body > tr.x-grid-row');
    const fileCount = await fileRows.count();
    console.log(`📄 Page ${pageIndex} | Found ${fileCount} files`);

    for (let i = 0; i < fileCount; i++) {
      console.log(`⚙️  Processing file ${i + 1}/${fileCount}`);

      // open “Select → View Record”
      await frame.locator(`#btnMore_${i}`).click();
      await page.waitForTimeout(1000);
      await frame.getByRole('link', { name: 'View Record' }).click();
      await page.waitForTimeout(5000);

      // trigger download
      const dlPromise = page.waitForEvent('download');
      await frame.getByTitle('Download Payment Grid Details').click();
      await page.waitForTimeout(3000);
      await frame.getByRole('link', { name: 'XLS' }).click();
      const download = await dlPromise;

      // save to disk
      const safeDate = dateStr.replace(/\//g, '-');
      const xlsPath = `tests/KotakReports/payment_${safeDate}_p${pageIndex}_f${i + 1}.xls`;
      await download.saveAs(xlsPath);
      console.log(`✅ Downloaded XLS → ${xlsPath}`);

      // ——— Parse with xlsx → JSON rows ———
      const wb = xlsx.readFile(xlsPath);
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = xlsx.utils.sheet_to_json(sheet, { defval: null });

      // inject metadata & store in Mongo
      const docs = rows.map(r => ({
        // ...r,
        Sending_Account_Number: r['Sending Account Number'],
        Receiver_Name: r['Receiver Name'],
        Receiver_Code: r['Receiver Code'],
        Product_Code: r['Product Code'],
        Package_Code: r['Package Code'],
        IFSC_Code: r['IFSC Code'],
        Receiver_Account_Number: r['Receiver Account Number'],
        Amount: r['Amount'],
        Instrument_Date: r['Instrument Date'],
        Effective_Date: r['Effective Date'],
        UTR_SrNo: r['UTR SrNo'],
        Instrument_No: r['Instrument No'],
        Instrument_Status: r['Instrument Status'],
        Maker: r['Maker'],
        Maker_DateTime: r['Maker DateTime'],
        Checker_1: r['Checker 1'],
        Checker_1_DateTime: r['Checker 1 DateTime'],
        Checker_2: r['Checker 2'],
        Checker_2_DateTime: r['Checker 2 DateTime'],
        Sent_By: r['Sent By'],
        Sent_By_DateTime: r['Sent By DateTime'],
        Instrument_Payment_Ref_No: r['Instrument Payment Ref No'],
        Batch_Payment_Ref_No: r['Batch Payment Ref No'],
        Payment_Details: r['Payment Details'],
        Payment_Details_2: r['Payment Details 2'],
        Payment_Details_3: r['Payment Details 3'],
        Payment_Details_4: r['Payment Details 4'],
        Host_Processing_Date_: r['Host Processing Date & Time '],
        Reject_Remarks: r['Reject Remarks'],
        Debit_Type: r['Debit Type'],
        Verified_Beneficiary_Name: r['Verified Beneficiary Name'],
        dateDownloaded: dateStr,
        page: pageIndex,
        file: i + 1,
        fetchedAt: new Date(),
      }));
      if (docs.length) {
        await collection.insertMany(docs);
        console.log(`💾 Inserted ${docs.length} docs into MongoDB`);

        // Delete the XLS file to save space
        try {
          fs.unlinkSync(xlsPath);
          console.log(`🗑️ Deleted XLS file: ${xlsPath}`);
        } catch (err) {
          console.warn(`⚠️ Failed to delete file ${xlsPath}:`, err.message);
        }

      } else {
        console.log('⚠️  No rows parsed from XLS');
      }

      // ——— Go back to file list ———
      await page.waitForTimeout(4000);
      await frame.getByRole('link', { name: 'Payments' }).click();
      await frame.getByRole('link', { name: 'Payment Center' }).click();
      await page.waitForTimeout(3000);
    }

    // next page?
    const nextBtn = frame.locator('a[role="button"][data-qtip="Next Page"]');
    const cls = await nextBtn.getAttribute('class');
    if (cls?.includes('x-item-disabled')) {
      hasNextPage = false;
      console.log('🚫 No more file pages');
    } else {
      console.log('👉 Moving to next file page');
      await nextBtn.click();
      await page.waitForTimeout(2000);
      pageIndex++;
    }
  }

  // ——— Cleanup ———
  await page.waitForTimeout(3000);
  await page.getByRole('listitem').filter({ hasText: 'AK' }).locator('span').click();
  await page.waitForTimeout(3000);
  await page.locator('app-header').getByText('Log out').click();

  await client.close();
  console.log('🎉 All files processed and saved to MongoDB!');
});

// ——— Global Error Notification Logic ———
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