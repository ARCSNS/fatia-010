# FATIA 010 API

Backend Node.js/Express para o site FATIA 010. Este serviço é separado do Static Site existente.

## Requisitos
- Node.js 20+
- PostgreSQL/Neon
- Variáveis de ambiente configuradas

## Executar localmente
1. `npm install`
2. Copie `.env.example` para `.env` e preencha os valores localmente.
3. `npm start`

## Primeiro administrador
Na primeira inicialização, se `ADMIN_USERNAME` e `ADMIN_PASSWORD` estiverem definidos, a API cria o administrador caso o username ainda não exista. A senha é armazenada com hash bcrypt. Não use senha fraca e não publique `.env`.

## Endpoints iniciais
- `GET /health`
- `GET /api/catalog` — categorias e produtos ativos/disponíveis
- `GET /api/neighborhoods`
- `GET /api/payment-methods`
- `POST /api/orders` — cria pedido validando preços, taxas e disponibilidade no banco
- `POST /api/admin/login`
- `GET /api/admin/orders` — autenticado
- `PATCH /api/admin/orders/:id/status` — autenticado

## Deploy no Render
Crie um **novo Web Service** conectado ao repositório, com Root Directory `api` (depois que esta pasta estiver no GitHub), Build Command `npm install` e Start Command `npm start`. Configure `DATABASE_URL`, `JWT_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` e `FRONTEND_ORIGIN` em Environment. Não altere nem exclua o Static Site atual.

## Observações
- A API não cria, altera ou remove tabelas.
- IDs e `order_number` são omitidos nos INSERTs para o PostgreSQL gerar automaticamente.
- Não compartilhe `DATABASE_URL`, senha do banco, `JWT_SECRET` ou senha administrativa.
- Antes de produção, revisar políticas de CORS, fluxo de pagamento e regras comerciais.
