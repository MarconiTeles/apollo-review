# Apollo Review — contrato do link único

Este documento descreve o modelo de **um único link vivo** que substitui o par
"Revisar" + "Ver revisão", e o que o lado **Apollo (Swift, repo
`apollo-review-swift`)** precisa fazer para fechar o ciclo (notificação + badge +
deep-link). O lado web (este repo) já está implementado.

---

## 1. Princípio: um link, sempre o mesmo

Antes havia dois links:

- **Revisar** → `?m=<mediaUrl>&…` abria o editor.
- **Ver revisão** → `?z=<payload comprimido>` carregava o review *dentro da URL*
  (imutável: o conteúdo **é** o link).

Agora há **um só**. Para reviews legadas, a identidade continua sendo o anexo
original do ClickUp. Para o fluxo versionado, a identidade é a linhagem lógica
do resultado e fica persistida como `reviewId`; V1/V2/V3 são anexos diferentes
dentro do mesmo blob `review:<reviewId>`. O link original permanece válido.

```
https://<web>/?att=<attachmentId>&task=<taskId>&m=<mediaUrl>&t=<title>&x=<ext>
            &up=<uploaderId>&un=<uploaderName>&by=<createdById>&actor=<actorId>
```

A URL **nunca muda**. O que muda é a linha. Revisor marca → autosalva. Executor
abre o **mesmo link** → vê os comentários com **checkboxes** e marca cada um como
resolvido → autosalva. Não há mais necessidade de login do ClickUp pelo revisor:
a identidade é o nome digitado (campo "Você é:"), persistido no navegador.

### O que o Apollo deve gerar
O botão **REVIEW** (no comentário de upload e no painel de anexos — ver as duas
capturas) deve apontar para esse link `?att=…`. **O mesmo link** serve para o
revisor e, depois, para quem executa. Pare de gerar um segundo link "VER REVIEW":
o `?z=` continua sendo decodificado só para links antigos já postados.

Parâmetros (todos do lado Apollo, identidade = ClickUp):

| Param   | Origem                              | Obrigatório |
|---------|-------------------------------------|-------------|
| `att`   | `reviewId` estável (anexo V1 no legado) | sim      |
| `task`  | task do anexo                       | sim         |
| `m`     | URL do anexo (mídia)                | sim         |
| `t`     | título do arquivo                   | recomendado |
| `x`     | extensão sem ponto (`mov`)          | recomendado |
| `up`    | ClickUp id de quem subiu (notificar)| recomendado |
| `un`    | nome de quem subiu (@menção)        | recomendado |
| `by`    | ClickUp id do criador do review     | recomendado |
| `actor` | ClickUp id de quem está abrindo     | opcional    |

---

## 2. Backend (já pronto neste repo)

Tudo passa pelo Cloudflare Worker (`worker/clickup-proxy.js`), que guarda o
segredo `CLICKUP_TOKEN` e o binding KV `REVIEWS`. O navegador nunca fala direto
com o KV nem com o ClickUp.

| Rota                | Quando                          | Efeito |
|---------------------|---------------------------------|--------|
| `/session/resolve`  | ao abrir o link                 | load-or-create do review estável, devolve mídia atual e versões |
| `/session/save`     | a cada mudança (debounce 800ms) | persiste status + comentários + marcações (blob inteiro) |
| `/session/conclude` | ao "Concluir review"            | registra conclusão explícita, separada do status aprovado |
| `/session/version`  | ao substituir uma mídia         | adiciona V2/V3 ao mesmo review, preservando histórico e comentários |

O estado é **um blob JSON por review lógico no Cloudflare KV** (chave
`review:<reviewId>`), sem banco externo. Blobs antigos sem `versions` são
interpretados como V1 sem migração destrutiva. `status` ∈
`in_review | changes_requested | approved`. Cada comentário tem
`resolved` + `resolvedByName` + `resolvedAt` (a checkbox).

---

## 3. O que falta no Apollo (Swift)

### 3a. Notificar o criador quando o link muda
KV não tem realtime — então o Apollo descobre mudanças por **polling leve**: ao
abrir/refrescar a task (ou num timer), chama `/session/resolve` para o anexo e
compara o `updatedAt` do blob com o último visto. Quando muda e o autor da
mudança **não é** o criador, notifica:

- alvo: `uploaderId` (quem subiu) e/ou `createdById`.
- gatilhos: transição de `status`, novos comentários, ou comentários marcados
  como `resolved` (executor concluiu itens).
- chave: `updatedAt` do blob para diferenciar "novo" de "já visto".

(Se quiser push em vez de poll depois, dá pra o Worker enfileirar uma
notificação — mas v1 é poll, que cobre o badge abaixo de graça.)

### 3b. Badge no ícone REVIEW
O botão REVIEW mostra um ponto/badge quando o `updatedAt` do blob for **mais
recente** que a última vez que o criador abriu aquele review. O "último visto" é
estado **local do Apollo** (por `attachmentId`) — não precisa ir ao servidor. Ao
abrir o link, zere o badge.

### 3c. Notificação → abre direto a tela do review
O deep-link já carrega `reviewId` (`src/contract/urlscheme.ts` → `OpenReviewParams.reviewId`).
A notificação, ao ser tocada, deve abrir:

```
apolloreview://open?taskId=…&attachmentId=…&reviewId=<id>&…
```

…levando direto à tela do review (sem passar pela lista). Se o app desktop não
estiver instalado, caia no `WEB_FALLBACK_BASE` apontando para o mesmo `?att=…`.

---

## 4. Estado de concorrência (v1)

Autosave via Worker (blob inteiro, último a salvar vence) + recarga ao focar.
Edição simultânea ao vivo por dois usuários fica para depois. O Apollo lê por
polling (3a), sem impacto.

---

## 5. Checklist de paridade ao mudar o modelo

Ao alterar qualquer forma de dados, espelhe em:

- `src/contract/model.ts` (modelo TS)
- `worker/clickup-proxy.js` (shape do blob KV + mapeamento ClickUp)
- `src/contract/urlscheme.ts` (deep-link)
- structs Codable do lado Apollo (`apollo-review-swift`)
