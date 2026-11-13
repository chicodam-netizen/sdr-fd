## Automação: caixa de entrada e cadências

Com o sistema no ar, a cada 10 minutos ele faz sozinho duas tarefas:

1. **Lê a caixa de entrada** (contato@fdconsultoria.tech): procura, nos e-mails dos últimos 7 dias, as respostas de leads que ainda não foram registradas. Os outros e-mails da caixa são ignorados, e nada é marcado como lido — você continua usando o webmail normalmente.
2. **Processa as cadências**: gera os e-mails dos passos que venceram.

No topo da tela **Aprovações** aparece o status: "Automação ligada", horário da última verificação e da próxima, e quantas respostas e rascunhos foram gerados. Os botões **Ler caixa de entrada** e **Processar cadências** continuam disponíveis para rodar na hora.

> Respostas aos leads **nunca** são enviadas sem aprovação: a IA escreve o rascunho e ele espera em Aprovações.

### O que acontece quando o lead responde

| O lead respondeu… | O sistema |
|---|---|
| Com interesse, pergunta, objeção, pedido de reunião, "agora não" ou "não sou a pessoa certa" | Para a cadência, move o card para **Em conversa** e a IA deixa um **rascunho de resposta** em Aprovações |
| Resposta automática de férias/ausência | Não faz nada: a cadência continua |
| Pediu para sair | Bloqueia o contato e encerra a cadência |
| Sem interesse | Para a cadência, sem rascunho; a decisão fica com você |

Em Aprovações, o rascunho de resposta vem com a **mensagem do lead**, a **classificação da IA** e o resumo, para revisar com contexto. Se o lead mandar outra mensagem antes de você aprovar, o rascunho é refeito considerando a mensagem nova.

**Importante:** responda sempre pelo sistema. Respostas enviadas direto pelo webmail não entram no histórico do card.

## Funil: movimentação automática

| Acontecimento | O card vai para |
|---|---|
| E-mail enviado ao lead | **Primeiro contato** |
| Lead respondeu e a conversa continua | **Em conversa** |

- O card só **avança**, nunca volta; cards em Qualificado/Desqualificado não são mexidos.
- Rascunho não move: só o envio de verdade.
- O histórico do card mostra "Movido automaticamente … (motivo)".
- As etapas são reconhecidas pelo nome ("Primeiro contato", "Em conversa"); se forem renomeadas, a automação deixa de mover para elas.

### Sugestão da IA: Qualificado / Desqualificado

Qualificar ou desqualificar é decisão comercial, por isso não é automático. Quando a resposta do lead indica um desses caminhos (ex.: pediu reunião, não tem interesse), aparece:

- no **Funil**, o selo **"IA sugere: Qualificado"** (verde) ou **"IA sugere: Desqualificado"** (vermelho) no card;
- em **Aprovações**, junto do rascunho de resposta, o botão **Mover para "Qualificado"**;
- na conversa do card, o mesmo botão.

Mover para Qualificado ou Desqualificado encerra a cadência do card.

## Cadência para vários leads de uma vez

- **Pela Base de leads:** selecione as empresas → **Enviar ao funil** → escolha o agente e marque **Iniciar a cadência do agente**.
- **Pelo Funil (cards que já estão lá):** mude para a visão **Lista**, marque os cards (ou a caixa do cabeçalho para todos os filtrados) → **Iniciar cadência** → escolha o agente. A janela avisa quantos serão pulados (sem e-mail ou já em cadência).
- A coluna **Cadência** da lista mostra quem está em cadência, aguardando aprovação ou pausado.

Cada lead segue a própria sequência: os dias de cada passo contam a partir do envio anterior **daquele** lead.

## E-mail avulso e cadência (sem duplicar)

- Para leads novos, use **Iniciar cadência**: ela gera o 1º e-mail e cuida dos follow-ups.
- Se já gerou um rascunho avulso e inicia a cadência antes de aprovar, o rascunho vira o 1º passo.
- Se já enviou um e-mail avulso, ao iniciar a cadência ela começa no 2º passo, contado a partir desse envio.

## Cadência mista com LinkedIn

O sistema **não acessa o LinkedIn** (a plataforma não permite automação). Os passos de LinkedIn são tarefas que você faz em poucos cliques, com o texto pronto pela IA.

**Configurar:** Agentes SDR → agente → Cadência → em cada passo escolha o canal: *E-mail*, *LinkedIn: pedido de conexão* ou *LinkedIn: mensagem*. Ex.: 1) e-mail (0 dias) → 2) conexão (2 dias) → 3) e-mail (3 dias) → 4) mensagem LinkedIn (4 dias).

**No dia a dia — menu LinkedIn:**
1. Cada tarefa mostra empresa, contato, cargo e o texto da IA (nota de conexão com contador de 300 caracteres).
2. **Abrir perfil** (ou **Buscar no LinkedIn** + colar o link do perfil e **Salvar perfil**, que fica gravado no contato).
3. **Copiar texto** → cole no LinkedIn → envie.
4. **Feito: enviei no LinkedIn** registra no histórico do card e a cadência segue. **Pular** (sem perfil, conexão não aceita) também faz a cadência seguir.

Passos de LinkedIn nunca saem sozinhos, mesmo com o agente em modo Autônomo, e não contam no limite diário de e-mails.

**Lead respondeu no LinkedIn:** abra o card → Conversa → *Registrar resposta recebida* → "Recebida no LinkedIn" → cole o texto. A IA classifica, a cadência para, o card vai para Em conversa e a resposta sugerida aparece como tarefa no menu LinkedIn.

No plano gratuito o LinkedIn limita convites (e convites com nota) por semana/mês: distribua as tarefas ao longo dos dias.
