require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const pdf = require('html-pdf');
const QRCode = require('qrcode');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const app = express();
const cors = require('cors');

app.use(cors());

app.use('/create-checkout-session', express.json());
app.use('/send-email', express.json());

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log('Recebida requisição para /webhook');
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log('Evento verificado:', event.type);
  } catch (err) {
    console.error('Erro ao verificar webhook:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    console.log('Evento checkout.session.completed recebido');
    const session = event.data.object;
    const { userId, siteId, plan, customUrl, email } = session.metadata;

    const { data: siteData, error: siteError } = await supabase
      .from('sites')
      .select('form_data, password, custom_url, media')
      .eq('id', siteId)
      .single();

    if (siteError) {
      console.error('Erro ao buscar dados do site:', siteError);
      return res.status(500).send('Erro ao buscar dados do site');
    }

    const { form_data, password, custom_url, media } = siteData;
    const siteUrl = `${process.env.FRONTEND_URL}/${customUrl}`;
    const selectedPhoto = media.photos && media.photos.length > 0 ? media.photos[0] : 'https://via.placeholder.com/300x200?text=Sem+Foto';
    const selectedColor = '#FDF8E3';

    const qrCodeUrl = await QRCode.toDataURL(siteUrl);

    const htmlContent = `
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Card Digital Premium - ${form_data.coupleName}</title>
        <style>
          body {
            background-color: ${selectedColor};
            font-family: 'Georgia', serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
          }
          .card {
            background-color: white;
            border-radius: 24px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
            width: 90%;
            max-width: 600px;
            padding: 32px;
            text-align: center;
            position: relative;
            overflow: hidden;
          }
          .card::before {
            content: '';
            position: absolute;
            top: -50px;
            left: -50px;
            width: 200px;
            height: 200px;
            background: radial-gradient(circle, rgba(255, 215, 0, 0.2) 0%, transparent 70%);
            z-index: 0;
          }
          .card::after {
            content: '';
            position: absolute;
            bottom: -50px;
            right: -50px;
            width: 200px;
            height: 200px;
            background: radial-gradient(circle, rgba(255, 215, 0, 0.2) 0%, transparent 70%);
            z-index: 0;
          }
          .card img.photo {
            width: 100%;
            max-height: 300px;
            object-fit: cover;
            border-radius: 16px;
            margin-bottom: 24px;
            position: relative;
            z-index: 1;
          }
          .card h1 {
            font-size: 32px;
            color: #872133;
            margin-bottom: 16px;
            font-weight: bold;
            position: relative;
            z-index: 1;
          }
          .card p.message {
            font-size: 18px;
            color: #6B1A28;
            font-style: italic;
            margin-bottom: 24px;
            position: relative;
            z-index: 1;
          }
          .card .details {
            display: flex;
            justify-content: space-between;
            margin-bottom: 24px;
            position: relative;
            z-index: 1;
            text-align: center;
          }
          .card .details p {
            font-size: 16px;
            color: #555;
            margin: 0 auto;
            text-align: center;
          }
          .card .qr-code {
            margin-top: 24px;
            position: relative;
            z-index: 1;
          }
          .card .qr-code img {
            width: 100px;
            height: 100px;
            margin-bottom: 8px;
          }
          .card .qr-code p {
            font-size: 14px;
            color: #555;
          }
          @media print {
            body {
              background-color: white;
            }
            .card {
              box-shadow: none;
              border: 1px solid #ddd;
            }
          }
        </style>
      </head>
      <body>
        <div class="card">
          <img class="photo" src="${selectedPhoto}" alt="Foto do Casal" />
          <h1>${form_data.coupleName}</h1>
          <p class="message">"${form_data.message}"</p>
          <div class="details">
            <p>Início: ${new Date(form_data.relationshipStartDate).toLocaleDateString('pt-BR')}</p>
          </div>
          <div class="qr-code">
            <img src="${qrCodeUrl}" alt="QR Code" />
            <p>Escaneie para visitar nosso Card Digital</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const transporter = nodemailer.createTransport({
      host: 'smtp.titan.email',
      port: 465,
      secure: true,
      auth: {
        user: 'administrador@amorempixels.com',
        pass: process.env.HOSTGATOR_EMAIL_PASSWORD,
      },
    });

    let pdfBuffer = null;
    if (plan === 'premium') {
      pdfBuffer = await new Promise((resolve, reject) => {
        pdf.create(htmlContent, { format: 'A4' }).toBuffer((err, buffer) => {
          if (err) reject(err);
          else resolve(buffer);
        });
      });
    }

    const mailOptions = {
      from: 'administrador@amorempixels.com',
      to: email,
      subject: 'Seu Card Digital foi Criado com Sucesso!',
      html: `
        <h1>Seu Card Digital está pronto!</h1>
        <p>Acesse seu Card Digital aqui: <a href="${siteUrl}">${siteUrl}</a></p>
        <p><strong>Senha para acesso:</strong> ${password}</p>
        ${plan === 'premium' ? '<p>Baixe seu PDF personalizado anexado a este e-mail.</p>' : ''}
      `,
      attachments: plan === 'premium'
        ? [{
            filename: `${customUrl}_card.pdf`,
            content: pdfBuffer,
            contentType: 'application/pdf',
          }]
        : [],
    };

    await transporter.sendMail(mailOptions);
    console.log('E-mail enviado com sucesso para:', email);

    const { error: updateError } = await supabase
      .from('sites')
      .update({ status: 'active' })
      .eq('id', siteId);

    if (updateError) {
      console.error('Erro ao atualizar status do site:', updateError);
      return res.status(500).send('Erro ao atualizar o site');
    }

    // Removido o upsert de user_plans, pois não há usuário logado
    console.log(`Site ${siteId} ativado com sucesso`);
  } else {
    console.log(`Evento ignorado: ${event.type}`);
  }

  res.status(200).json({ received: true });
});

app.post('/create-checkout-session', async (req, res) => {
  console.log('Recebida requisição para /create-checkout-session');
  const { userId, customUrl, plan, siteId, email } = req.body;

  //PRODUÇÃO
  //const priceId = plan === 'basic' ? 'price_1R3j3ME7ALxB5NeWiBpb4IAo' : 'price_1R3j3rE7ALxB5NeW3ff6tK6c';

  //TESTE
  const priceId = plan === 'basic' ? 'price_1R58JoE7ALxB5NeWzbQCbJLv' : 'price_1R58KJE7ALxB5NeWSP88W0mQ';

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/confirmation?success=true&siteId=${siteId}`,
      cancel_url: `${process.env.FRONTEND_URL}/criar?canceled=true`,
      metadata: { userId: userId || null, customUrl, siteId, plan, email },
      currency: 'brl',
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Erro ao criar sessão de checkout:', error.message, error.stack);
    res.status(500).json({ error: 'Erro ao criar sessão de checkout', details: error.message });
  }
});

app.post('/send-email', async (req, res) => {
  console.log('Recebida requisição para /send-email');
  const { to, subject, body, isHtml = false } = req.body;

  if (!to || !subject || !body) {
    console.log('Campos obrigatórios ausentes:', { to, subject, body });
    return res.status(400).json({ error: 'Todos os campos (to, subject, body) são obrigatórios.' });
  }

  const transporter = nodemailer.createTransport({
    host: 'smtp.titan.email',
    port: 465,
    secure: true,
    auth: {
      user: 'administrador@amorempixels.com',
      pass: process.env.HOSTGATOR_EMAIL_PASSWORD,
    },
  });

  const mailOptions = {
    from: 'administrador@amorempixels.com',
    to,
    subject,
    ...(isHtml ? { html: body } : { text: body }),
  };

  try {
    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'E-mail enviado com sucesso!' });
  } catch (error) {
    console.error('Erro ao enviar e-mail:', error);
    res.status(500).json({ error: 'Falha ao enviar o e-mail.' });
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));
