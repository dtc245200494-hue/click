export async function sendTelegramSummary(campaign, env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatIds = String(env.TELEGRAM_CHAT_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!token || chatIds.length === 0) return;
  const text = [
    `Campaign: ${campaign.name}`,
    `Status: ${campaign.status}`,
    `Target: ${campaign.targetRequests}`,
    `Success: ${campaign.success}`,
    `Failed attempts: ${campaign.failedAttempts}`,
    `Attempted: ${campaign.attempted}`
  ].join('\n');

  for (const chatId of chatIds) {
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text })
      });
    } catch (error) {
      console.error('[telegram]', error.message);
    }
  }
}
