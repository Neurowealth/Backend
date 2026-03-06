import express, { Router, Request, Response } from 'express';
import { config } from '../config/env';
import { handleWhatsAppMessage } from '../whatsapp/handler';
import twilio from 'twilio';

const router = Router();

// Twilio sends form-encoded data for messaging webhooks
router.use(express.urlencoded({ extended: false }));

// Health check
router.get('/webhook', (req: Request, res: Response) => {
  res.status(200).send('OK');
});

// Message receiver
router.post('/webhook', async (req: Request, res: Response) => {
  try {
    const signature = req.header('x-twilio-signature') || '';
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const valid = twilio.validateRequest(
      config.whatsapp.twilioToken,
      signature,
      url,
      req.body
    );
    if (!valid) {
      return res.status(403).send('Invalid Twilio signature');
    }

    const from = req.body.From || '';
    const body = req.body.Body || '';

    const responseText = await handleWhatsAppMessage(from, body);

    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(responseText);
    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('whatsapp webhook error', err);
    res.status(500).send('Server error');
  }
});

export default router;
