# Guia de Produção e Manutenção

## Visão geral do projeto

- **Frontend**: React + Vite em `src/`
- **Backend**: Node.js + Express em `server/src/`
- **Banco de dados**: SQLite em `server/data/sports-center.db`
- **Uploads de comprovantes**: `server/uploads/`
- **Produção atual**: o `Express` serve a API e também os arquivos gerados em `dist/`

## Como iniciar o projeto em desenvolvimento

### Instalar dependências

```bash
npm install
npm install --prefix server
```

### Rodar frontend + backend juntos

```bash
npm run dev
```

### Rodar separadamente, se quiser

```bash
npm run dev:client
npm run dev:server
```

## Como subir em produção

## Fluxo recomendado

Este projeto funciona melhor em um ambiente com **disco persistente**, porque usa:

- SQLite local
- pasta local de uploads

Exemplos: VPS, Railway com volume, Render com disk, servidor Node tradicional.

## Passos

### 1. Instalar dependências

```bash
npm install
npm install --prefix server
```

### 2. Gerar o build do frontend

```bash
npm run build
```

### 3. Configurar variáveis de ambiente

Configure no ambiente de produção:

```text
JWT_SECRET=coloque_um_segredo_forte_aqui
PORT=4000
HOST=0.0.0.0
PROOF_RETENTION_MONTHS=3
PROOF_CLEANUP_INTERVAL_MS=86400000
```

### 4. Iniciar o servidor

```bash
npm start
```

## Observações importantes de produção

- **API e site**: em produção, o backend serve o conteúdo de `dist/` e a API na mesma origem.
- **VITE_API_BASE**: só é necessário se você quiser buildar o frontend apontando para outra origem de API.
- **Pastas de persistência**: o backend cria `server/data/` e `server/uploads/` se elas não existirem.
- **JWT**: não use o valor padrão em produção.

## Admin padrão

Se não existir nenhum usuário admin no banco, o sistema cria automaticamente:

- **E-mail**: `admin@esportesce.com`
- **Senha inicial**: `admin123`

Após subir em produção, troque essa senha o quanto antes.

## Onde ficam os dados

- **Usuários, pagamentos e feedbacks**: dentro do SQLite `server/data/sports-center.db`
- **Feedbacks**: ficam na tabela `feedbacks`
- **Comprovantes**: ficam em `server/uploads/`
- **Referências dos arquivos**: ficam nas colunas `proof_file` e `admin_proof_file` da tabela `payments`

## Como resetar tudo do zero

Use isso quando quiser apagar todos os usuários de teste, pagamentos, feedbacks e comprovantes e recomeçar com uma base limpa.

### Comando npm recomendado

Com o backend parado, rode:

```bash
npm run reset:data
```

Esse comando faz automaticamente:

- remove `server/data/sports-center.db`, se existir
- remove `server/sports-center.db`, se existir
- recria a pasta `server/uploads/` vazia

Depois disso, basta iniciar o backend novamente para o sistema recriar a base e o admin padrão.

### Passos

1. Pare o backend.
2. Apague os arquivos abaixo, se existirem:
   - `server/data/sports-center.db`
   - `server/sports-center.db`
3. Apague o conteúdo da pasta:
   - `server/uploads/`
4. Inicie o backend novamente.

Ao subir de novo, o sistema vai:

- recriar as tabelas
- recriar o admin padrão

## Como apagar apenas usuários de teste

Se quiser manter a estrutura do banco, mas apagar só os usuários comuns, abra o banco SQLite e rode os comandos SQL abaixo.

## Como abrir o banco

Você pode usar uma destas opções:

- **DB Browser for SQLite** abrindo `server/data/sports-center.db`
- **CLI do sqlite3**, se estiver instalada

Exemplo com CLI:

```bash
sqlite3 server/data/sports-center.db
```

## SQL para apagar usuários comuns

```sql
DELETE FROM feedbacks
WHERE user_id IN (SELECT id FROM users WHERE role = 'user');

DELETE FROM payments
WHERE user_id IN (SELECT id FROM users WHERE role = 'user');

DELETE FROM users
WHERE role = 'user';

VACUUM;
```

### Observação importante

Se os comprovantes desses usuários também forem apenas de teste, limpe também a pasta `server/uploads/`, porque apagar os registros da tabela `payments` não remove automaticamente os arquivos físicos antigos.

## Como apagar apenas feedbacks

```sql
DELETE FROM feedbacks;
VACUUM;
```

## Como apagar apenas comprovantes enviados

Se você quiser manter os pagamentos, mas remover os arquivos anexados:

### 1. Limpe as referências no banco

```sql
UPDATE payments
SET proof_file = NULL,
    admin_proof_file = NULL;
```

### 2. Apague os arquivos físicos

Remova os arquivos dentro de:

- `server/uploads/`

## Como limpar só a base de feedbacks

A base de feedbacks não é separada. Ela fica no mesmo banco SQLite.

Para apagar tudo:

```sql
DELETE FROM feedbacks;
VACUUM;
```

## Exclusão automática de comprovantes após 3 meses

O backend foi configurado para fazer a limpeza automática dos comprovantes antigos.

## Como funciona

- considera pagamentos com data superior ao limite configurado
- remove os arquivos físicos em `server/uploads/`
- limpa as colunas `proof_file` e `admin_proof_file`
- roda uma vez no startup do backend
- depois roda periodicamente

## Configuração atual

- **Retenção padrão**: `3` meses
- **Intervalo de varredura padrão**: `24h`

## Variáveis relacionadas

```text
PROOF_RETENTION_MONTHS=3
PROOF_CLEANUP_INTERVAL_MS=86400000
```

Exemplo: para manter por 6 meses:

```text
PROOF_RETENTION_MONTHS=6
```

## Git: evitando subir base local e uploads

O `.gitignore` foi ajustado para ignorar:

- `server/data/`
- `server/uploads/`
- `server/*.db`

## Importante

Se esses arquivos **já foram versionados antes**, o `.gitignore` sozinho não resolve. Você precisa remover do Git com:

```bash
git rm --cached -r -- server/data server/uploads
git rm --cached -- server/sports-center.db
git commit -m "Stop tracking local database and uploads"
git push
```

Isso remove os arquivos do repositório, mas mantém os arquivos locais no seu computador.

## Checklist antes de publicar em produção

- **Definir `JWT_SECRET` forte**
- **Trocar a senha do admin padrão**
- **Garantir disco persistente para `server/data` e `server/uploads`**
- **Remover do Git a base local e uploads, se ainda estiverem rastreados**
- **Decidir se vai começar com base limpa ou importar dados reais**
- **Executar `npm run build` antes do `npm start`**

## Comandos úteis

### Desenvolvimento

```bash
npm run dev
```

### Build do frontend

```bash
npm run build
```

### Subir em produção

```bash
npm start
```

### Resetar base local e uploads

```bash
npm run reset:data
```

### Verificar sintaxe do backend

```bash
node --check server/src/server.js
```

## Resumo rápido

- **Reset total**: `npm run reset:data` e depois reiniciar o backend
- **Apagar usuários de teste**: SQL na tabela `users`, `payments` e `feedbacks`
- **Apagar feedbacks**: `DELETE FROM feedbacks`
- **Apagar arquivos enviados**: limpar referências no banco + apagar `server/uploads/`
- **Comprovantes antigos**: agora são removidos automaticamente após 3 meses por padrão
