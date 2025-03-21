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

// Middleware de CORS aplicado globalmente
app.use(cors());

// Endpoint webhook deve vir ANTES de qualquer middleware que parseie o corpo
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
    const { pendingSiteId, plan, customUrl, email } = session.metadata;

    // Buscar os dados do site temporário
    const { data: pendingSite, error: pendingError } = await supabase
      .from('pending_sites')
      .select('site_data')
      .eq('id', pendingSiteId)
      .single();

    if (pendingError || !pendingSite) {
      console.error('Erro ao buscar dados do site temporário:', pendingError);
      return res.status(500).send('Erro ao buscar dados do site temporário');
    }

    const siteData = pendingSite.site_data;

    // Fazer o upload das fotos
    const photoUrls = await Promise.all(
      siteData.media.photos.map(async (photo, index) => {
        const base64Data = photo.data.replace(/^data:[^;]+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const { data, error } = await supabase.storage
          .from('media')
          .upload(`${siteData.custom_url}/photos/photo-${index}-${Date.now()}.${photo.name.split('.').pop()}`, buffer, {
            contentType: photo.data.split(';')[0].split(':')[1],
          });
        if (error) throw new Error(`Erro ao fazer upload da foto ${index}: ${error.message}`);
        return supabase.storage.from('media').getPublicUrl(data.path).data.publicUrl;
      })
    );

    // Fazer o upload das músicas
    const musicUrls = await Promise.all(
      siteData.media.musics.map(async (music, index) => {
        const base64Data = music.data.replace(/^data:[^;]+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        const { data, error } = await supabase.storage
          .from('media')
          .upload(`${siteData.custom_url}/musics/music-${index}-${Date.now()}.${music.name.split('.').pop()}`, buffer, {
            contentType: music.data.split(';')[0].split(':')[1],
          });
        if (error) throw new Error(`Erro ao fazer upload da música ${index}: ${error.message}`);
        return supabase.storage.from('media').getPublicUrl(data.path).data.publicUrl;
      })
    );

    // Criar o site na tabela sites
    const finalSiteData = {
      custom_url: siteData.custom_url,
      user_id: siteData.user_id,
      form_data: siteData.form_data,
      plan: siteData.plan,
      media: {
        photos: photoUrls,
        musics: musicUrls,
        spotifyLink: siteData.media.spotifyLink,
      },
      created_at: siteData.created_at,
      expiration_date: siteData.expiration_date,
      status: 'active', // Agora o status já é active, pois o pagamento foi confirmado
      template_type: siteData.template_type,
      password: siteData.password,
      email: siteData.email,
    };

    const { data: site, error: siteError } = await supabase
      .from('sites')
      .insert([finalSiteData])
      .select('id')
      .single();

    if (siteError) {
      console.error('Erro ao criar o site:', siteError);
      return res.status(500).send('Erro ao criar o site');
    }

    const siteUrl = `${process.env.FRONTEND_URL}${siteData.custom_url}`;
    const selectedPhoto = photoUrls.length > 0 ? photoUrls[0] : 'https://via.placeholder.com/300x200?text=Sem+Foto';
    const selectedColor = '#FDF8E3';

    const qrCodeUrl = await QRCode.toDataURL(siteUrl);

    const htmlContent = `
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Card Digital Premium - ${siteData.form_data.coupleName}</title>
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
          <h1>${siteData.form_data.coupleName}</h1>
          <p class="message">"${siteData.form_data.message}"</p>
          <div class="details">
            <p>Início: ${new Date(siteData.form_data.relationshipStartDate).toLocaleDateString('pt-BR')}</p>
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
  subject: 'Seu Card Digital foi Criado com Sucesso! 💕',
  html: `
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Seu Card Digital - Amor em Pixels</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        body {
          font-family: 'Georgia', serif;
          background-color: #f5f5f5;
          color: #333;
          line-height: 1.6;
          padding: 20px;
        }
        .container {
          max-width: 600px;
          margin: 0 auto;
          background: linear-gradient(135deg, #fdf8e3 0%, #fff5f5 100%);
          border-radius: 16px;
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
          overflow: hidden;
          position: relative;
        }
        .container::before {
          content: '';
          position: absolute;
          top: -50px;
          left: -50px;
          width: 150px;
          height: 150px;
          background: radial-gradient(circle, rgba(255, 215, 0, 0.2) 0%, transparent 70%);
          z-index: 1;
        }
        .container::after {
          content: '';
          position: absolute;
          bottom: -50px;
          right: -50px;
          width: 150px;
          height: 150px;
          background: radial-gradient(circle, rgba(255, 105, 180, 0.2) 0%, transparent 70%);
          z-index: 1;
        }
        .header {
          background: linear-gradient(90deg, #ff6f91 0%, #ffcccb 100%);
          padding: 30px;
          text-align: center;
          position: relative;
          z-index: 2;
        }
        .header h1 {
          font-size: 28px;
          color: #fff;
          font-weight: bold;
          text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.1);
        }
        .header p {
          font-size: 16px;
          color: #fff;
          margin-top: 8px;
          opacity: 0.9;
        }
        .content {
          padding: 40px 30px;
          text-align: center;
          position: relative;
          z-index: 2;
        }
        .content h2 {
          font-size: 24px;
          color: #872133;
          margin-bottom: 20px;
          font-weight: bold;
        }
        .content p {
          font-size: 16px;
          color: #6b1a28;
          margin-bottom: 20px;
        }
        .content .highlight {
          background-color: #fff5f5;
          padding: 15px;
          border-radius: 8px;
          margin-bottom: 20px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
        }
        .content .highlight p {
          font-size: 16px;
          color: #333;
        }
        .content .highlight strong {
          color: #872133;
        }
        .content a {
          display: inline-block;
          background: linear-gradient(90deg, #ff6f91 0%, #ffcccb 100%);
          color: #fff;
          padding: 12px 24px;
          border-radius: 25px;
          text-decoration: none;
          font-size: 16px;
          font-weight: bold;
          transition: transform 0.2s ease;
          margin: 10px 0;
        }
        .content a:hover {
          transform: scale(1.05);
        }
        .footer {
          background-color: #fff5f5;
          padding: 20px;
          text-align: center;
          font-size: 14px;
          color: #6b1a28;
          border-top: 1px solid rgba(0, 0, 0, 0.05);
          position: relative;
          z-index: 2;
        }
        .footer p {
          margin: 0;
        }
        .footer a {
          color: #ff6f91;
          text-decoration: none;
          font-weight: bold;
        }
        .footer a:hover {
          text-decoration: underline;
        }
        @media (max-width: 600px) {
          .container {
            margin: 0 10px;
          }
          .header h1 {
            font-size: 24px;
          }
          .content {
            padding: 30px 20px;
          }
          .content h2 {
            font-size: 20px;
          }
          .content p {
            font-size: 14px;
          }
          .content a {
            padding: 10px 20px;
            font-size: 14px;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Seu Card Digital Está Pronto! 💕</h1>
          <p>Amor em Pixels - Celebre sua história de amor</p>
        </div>
        <div class="content">
          <h2>Olá, ${siteData.form_data.coupleName}!</h2>
          <p>Estamos felizes em informar que seu Card Digital foi criado com sucesso! Agora você pode compartilhar sua história de amor de uma forma única e especial.</p>
          <div class="highlight">
            <p><strong>Link do seu Card:</strong></p>
            <a href="${siteUrl}" target="_blank">Acesse aqui: ${siteUrl}</a>
          </div>
          <div class="highlight">
            <p><strong>Senha para acesso:</strong> ${siteData.password}</p>
          </div>
          ${
            plan === 'premium'
              ? `
                <div class="highlight">
                  <p>Como você escolheu o plano Premium, anexamos ao e-mail o PDF personalizado do seu Card Digital. Baixe e guarde com carinho! 💌</p>
                </div>
              `
              : ''
          }
          <p>Se precisar de ajuda ou quiser personalizar ainda mais, entre em contato conosco!</p>
        </div>
        <div class="footer">
          <p>Feito com 💖 por <a href="https://amorempixels.com" target="_blank">Amor em Pixels</a></p>
          <p>© ${new Date().getFullYear()} - Todos os direitos reservados</p>
        </div>
      </div>
    </body>
    </html>
  `,
  attachments: plan === 'premium'
    ? [
        {
          filename: `${siteData.custom_url}_card.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ]
    : [],
};

    await transporter.sendMail(mailOptions);
    console.log('E-mail enviado com sucesso para:', email);

    // Deletar o registro temporário
    await supabase.from('pending_sites').delete().eq('id', pendingSiteId);

    console.log(`Site criado com sucesso: ${site.id}`);
  } else {
    console.log(`Evento ignorado: ${event.type}`);
  }

  res.status(200).json({ received: true });
});

// Agora aplicamos os middlewares que parseiam o corpo APÓS o webhook
app.use(express.json({ limit: '10mb' })); // Aumentar o limite para 10MB
app.use(express.urlencoded({ limit: '10mb', extended: true })); // Para dados URL-encoded, se necessário

app.post('/create-checkout-session', async (req, res) => {
  console.log('Recebida requisição para /create-checkout-session');
  const { userId, customUrl, plan, email, siteData } = req.body;

  const priceId = plan === 'basic' ? 'price_1R3j3ME7ALxB5NeWiBpb4IAo' : 'price_1R3j3rE7ALxB5NeW3ff6tK6c';
  console.log('Price ID selecionado:', priceId);

  try {
    // Salvar os dados do site temporariamente
    const { data: pendingSite, error: pendingError } = await supabase
      .from('pending_sites')
      .insert([{ site_data: siteData }])
      .select('id')
      .single();

    if (pendingError) {
      console.error('Erro ao salvar dados temporários:', pendingError);
      return res.status(500).json({ error: 'Erro ao salvar dados temporários', details: pendingError.message });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}confirmation?success=true`,
      cancel_url: `${process.env.FRONTEND_URL}criar?canceled=true`,
      metadata: {
        userId: userId || null,
        customUrl,
        plan,
        email,
        pendingSiteId: pendingSite.id,
      },
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
