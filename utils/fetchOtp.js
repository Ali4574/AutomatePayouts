import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();
const MONGODB_URI_ALI = process.env.MONGODB_URI_ALI; 

export async function fetchLatestOtp(afterTimestamp = null) {
  const client = new MongoClient(MONGODB_URI_ALI);
  try {
    await client.connect();
    const db = client.db();
    const query = afterTimestamp
      ? { createdAt: { $gt: new Date(Number(afterTimestamp)) } }
      : {};

    const otp = await db.collection('otps').findOne(query, {
      sort: { createdAt: -1 },
    });

    return otp?.otp || null;
  } catch (err) {
    console.error('❌ fetchLatestOtp error:', err.message);
    return null;
  } finally {
    await client.close();
  }
}
