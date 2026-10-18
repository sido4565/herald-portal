// sms.js
async function sendSMS(phoneNumber, message) {
  const apiKey = process.env.TEXTBEE_API_KEY;
  if (!apiKey) {
    console.error('TextBee API key is missing from .env');
    return;
  }

  // Ensure the number is in E.164 format (starts with + and country code)
  // Remove any spaces or dashes the user might have typed
  const cleanNumber = phoneNumber.replace(/[\s-]/g, '');
  
  // Basic validation to ensure it starts with +
  if (!cleanNumber.startsWith('+')) {
    console.error('Phone number must be in E.164 format (e.g., +254...).');
    return;
  }

  try {
    const res = await fetch('https://api.textbee.dev/api/v1/gateway/send-sms', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipients: [cleanNumber],
        message: message,
      }),
    });

    const data = await res.json();
    
    if (!res.ok) {
      // Handle specific errors like invalid device, unverified email, etc.
      throw new Error(data.message || `HTTP error! status: ${res.status}`);
    }
    
    console.log(`SMS queued successfully for ${cleanNumber}. Batch ID: ${data.data.smsBatchId}`);
    return data;
  } catch (error) {
    console.error('TextBee SMS error:', error.message);
    // You can choose to throw the error if you want the calling function to handle it
    // throw error; 
  }
}

module.exports = { sendSMS };