// Gmail / SMTP OTP Verification Email Service - lib/mailer.js
const nodemailer = require('nodemailer');

function getEmailConfig(db) {
  const s = {};
  if (db) {
    try {
      const rows = db
        .prepare("SELECT key, value FROM settings WHERE key IN ('smtp_email', 'smtp_app_password', 'smtp_from_name', 'shop_name', 'shop_name_en')")
        .all();
      rows.forEach((r) => {
        s[r.key] = r.value;
      });
    } catch (_) {}
  }

  const smtpEmail = (s.smtp_email || process.env.SMTP_EMAIL || '').trim();
  const smtpAppPassword = (s.smtp_app_password || process.env.SMTP_APP_PASSWORD || '').replace(/\s+/g, '').trim();
  const fromName = (s.smtp_from_name || s.shop_name_en || 'Lungi Ghar').trim();

  return {
    smtpEmail,
    smtpAppPassword,
    fromName,
    configured: Boolean(smtpEmail && smtpAppPassword)
  };
}

function buildOtpHtml({ fromName, name, code }) {
  return `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e2dc;border-radius:12px;overflow:hidden;">
      <div style="background:#0f4c3a;color:#ffffff;padding:22px 26px;">
        <h2 style="margin:0;font-size:20px;">${fromName}</h2>
        <p style="margin:4px 0 0;font-size:12px;opacity:0.85;">Email Verification Code</p>
      </div>
      <div style="padding:28px 26px;color:#14191f;">
        <p style="margin:0 0 12px;font-size:15px;">হ্যালো <strong>${name}</strong>,</p>
        <p style="margin:0 0 18px;font-size:14px;color:#475569;line-height:1.6;">
          আপনার অ্যাকাউন্ট রেজিস্ট্রেশন সম্পূর্ণ করতে নিচের ৬-সংখ্যার ভেরিফিকেশন কোডটি ব্যবহার করুন (কোডটি ১০ মিনিট কার্যকর থাকবে):
        </p>
        <div style="background:#eef5f2;border:1px solid #cce3d8;border-radius:10px;padding:18px;text-align:center;margin-bottom:20px;">
          <span style="font-size:32px;font-weight:800;letter-spacing:8px;color:#0f4c3a;">${code}</span>
        </div>
        <p style="margin:0;font-size:12.5px;color:#64748b;">
          If you did not request this code, please ignore this email.
        </p>
      </div>
    </div>
  `;
}

async function sendVerificationCodeEmail(db, { toEmail, name, code }) {
  const cfg = getEmailConfig(db);

  if (!cfg.configured) {
    console.log(`[OTP Sandbox Mode] Verification code for ${toEmail}: ${code}`);
    return { sent: false, demoMode: true };
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: cfg.smtpEmail,
      pass: cfg.smtpAppPassword
    }
  });

  await transporter.sendMail({
    from: `"${cfg.fromName}" <${cfg.smtpEmail}>`,
    to: toEmail,
    subject: `${code} — ${cfg.fromName} Verification Code`,
    text: `Hello ${name}, your verification code is: ${code} (valid for 10 minutes).`,
    html: buildOtpHtml({ fromName: cfg.fromName, name, code })
  });

  return { sent: true, demoMode: false };
}

function buildPasswordResetHtml({ fromName, name, code }) {
  return `
    <div style="font-family:'Segoe UI',Arial,sans-serif;max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e2dc;border-radius:12px;overflow:hidden;">
      <div style="background:#0f4c3a;color:#ffffff;padding:22px 26px;">
        <h2 style="margin:0;font-size:20px;">${fromName}</h2>
        <p style="margin:4px 0 0;font-size:12px;opacity:0.85;">Password Reset Request</p>
      </div>
      <div style="padding:28px 26px;color:#14191f;">
        <p style="margin:0 0 12px;font-size:15px;">হ্যালো <strong>${name}</strong>,</p>
        <p style="margin:0 0 18px;font-size:14px;color:#475569;line-height:1.6;">
          আপনার অ্যাকাউন্টের পাসওয়ার্ড রিসেট করার জন্য অনুরোধ করা হয়েছে। নিচের ৬-সংখ্যার সিকিউরিটি কোডটি ব্যবহার করে নতুন পাসওয়ার্ড সেট করুন (কোডটি ১০ মিনিট কার্যকর থাকবে):
        </p>
        <div style="background:#eef5f2;border:1px solid #cce3d8;border-radius:10px;padding:18px;text-align:center;margin-bottom:20px;">
          <span style="font-size:32px;font-weight:800;letter-spacing:8px;color:#0f4c3a;">${code}</span>
        </div>
        <p style="margin:0;font-size:12.5px;color:#64748b;">
          আপনি যদি পাসওয়ার্ড রিসেটের অনুরোধ না করে থাকেন, তবে এই ইমেইলটি উপেক্ষা করুন। আপনার অ্যাকাউন্ট সম্পূর্ণ নিরাপদ রয়েছে।
        </p>
      </div>
    </div>
  `;
}

async function sendPasswordResetEmail(db, { toEmail, name, code }) {
  const cfg = getEmailConfig(db);

  if (!cfg.configured) {
    console.log(`[Password Reset Sandbox] Reset code for ${toEmail}: ${code}`);
    return { sent: false, demoMode: true };
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: cfg.smtpEmail,
      pass: cfg.smtpAppPassword
    }
  });

  await transporter.sendMail({
    from: `"${cfg.fromName}" <${cfg.smtpEmail}>`,
    to: toEmail,
    subject: `${code} — ${cfg.fromName} Password Reset Code`,
    text: `Hello ${name}, your password reset code is: ${code} (valid for 10 minutes).`,
    html: buildPasswordResetHtml({ fromName: cfg.fromName, name, code })
  });

  return { sent: true, demoMode: false };
}

async function sendTestEmail(db, toEmail) {
  const cfg = getEmailConfig(db);
  if (!cfg.configured) {
    return {
      success: false,
      message: 'প্রথমে Gmail Address এবং ১৬-সংখ্যার App Password সেভ করুন।'
    };
  }

  try {
    const testCode = '482915';
    await sendVerificationCodeEmail(db, {
      toEmail: toEmail || cfg.smtpEmail,
      name: 'Admin Test',
      code: testCode
    });
    return {
      success: true,
      message: `টেস্ট ইমেইল সফলভাবে পাঠানো হয়েছে (${toEmail || cfg.smtpEmail})!`
    };
  } catch (err) {
    return {
      success: false,
      message: `Gmail পাঠানো যায়নি: ${err.message}`
    };
  }
}

module.exports = {
  getEmailConfig,
  sendVerificationCodeEmail,
  sendPasswordResetEmail,
  sendTestEmail
};
