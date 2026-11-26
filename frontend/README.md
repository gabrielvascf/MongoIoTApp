# Solo Vivo frontend

Painel React + TypeScript para visualizar as leituras de sensores de solo. O estilo usa Tailwind CSS.

## Desenvolvimento local

Requer Node.js e pnpm. Inicie o servidor e o MongoDB em outro terminal; depois rode:

```sh
pnpm install
pnpm start
```

O painel abre em <http://localhost:3000> e encaminha as chamadas da API para `http://localhost:7878`.

## Build e testes

```sh
pnpm test --watchAll=false
pnpm build
```
