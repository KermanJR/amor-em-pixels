require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const app = express();
const cors = require('cors');

app.use(cors());

// Middleware para JSON apenas para /create-checkout-session
app.use('/create-checkout-session', express.json());

// Webhook com corpo bruto
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  console.log('Recebida requisição para /webhook');
  console.log('Tipo do req.body:', typeof req.body); // Depuração: verifica se é Buffer
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    console.log('Verificando assinatura do webhook...');
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    console.log('Evento verificado:', event.type);
  } catch (err) {
    console.error('Erro ao verificar webhook:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    console.log('Evento checkout.session.completed recebido');
    const session = event.data.object;
    const { userId, siteId, plan } = session.metadata;
    console.log('Metadados do evento:', { userId, siteId, plan });

    // Atualizar o status do site para 'active' após o pagamento
    console.log('Atualizando status do site no Supabase...');
    const { error: siteError } = await supabase
      .from('sites')
      .update({ status: 'active' })
      .eq('id', siteId)
      .eq('user_id', userId);

    if (siteError) {
      console.error('Erro ao atualizar status do site:', siteError);
      return res.status(500).send('Erro ao atualizar o site');
    }

    // Atualizar ou criar o plano do usuário
    console.log('Atualizando plano do usuário no Supabase...');
    const { error: planError } = await supabase
      .from('user_plans')
      .upsert({
        user_id: userId,
        package_type: plan,
        purchase_date: new Date().toISOString(),
      });

    if (planError) {
      console.error('Erro ao atualizar plano do usuário:', planError);
      return res.status(500).send('Erro ao atualizar o plano');
    }

    console.log(`Site ${siteId} ativado com sucesso para o usuário ${userId}`);
  } else {
    console.log(`Evento ignorado: ${event.type}`);
  }

  res.status(200).json({ received: true });
});

// Endpoint para criar a sessão de checkout
app.post('/create-checkout-session', async (req, res) => {
  console.log('Recebida requisição para /create-checkout-session');
  const { userId, customUrl, plan, siteId } = req.body;
  console.log('Dados recebidos:', { userId, customUrl, plan, siteId });

  const priceId = plan === 'basic' ? 'price_1R3j3ME7ALxB5NeWiBpb4IAo' : 'price_1R3j3rE7ALxB5NeW3ff6tK6c';
  console.log('Price ID selecionado:', priceId);

  try {
    console.log('Criando sessão no Stripe...');
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}dashboard?success=true&siteId=${siteId}`,
      cancel_url: `${process.env.FRONTEND_URL}dashboard?canceled=true`,
      metadata: { userId, customUrl, siteId, plan },
    });
    console.log('Sessão criada com sucesso:', session.id);

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Erro ao criar sessão de checkout:', error.message);
    res.status(500).json({ error: 'Erro ao criar sessão de checkout' });
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));
