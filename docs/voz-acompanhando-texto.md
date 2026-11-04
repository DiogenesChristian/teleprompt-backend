# Diogenes — voz acompanhando o texto

## O que mudou

- Backend: acompanha hipóteses parciais sem duplicar o histórico, confirmar âncoras ou contar as revisões no ritmo. Retoma por trechos curtos após repetições, autocorreções e frases omitidas, com busca limitada às próximas 140 palavras. A posição automática não recua durante uma repetição; o salto manual continua disponível.
- Deepgram: ignora resultados duplicados ou atrasados cujo intervalo de áudio já foi finalizado. Mantém `is_final` para confirmar segmentos, conforme a documentação oficial: https://developers.deepgram.com/docs/understand-endpointing-interim-results
- Frontend: envia também as transcrições parciais do navegador, usa o ritmo informado pelo servidor e aproxima a linha da posição reconhecida com suavidade. A rolagem não passa desse limite. A troca de tópico não chama mais um salto que reposicionava o rastreador.
- Números por extenso usam a mesma normalização nos dois projetos. O cache do aplicativo foi atualizado para carregar os scripts novos.

## Preparação

1. Use as versões alteradas dos dois projetos em conjunto. Mantenha as configurações locais de conexão, contas e chaves.
2. No backend, execute `npm ci --prefix backend-node` e `npm start`. Configure `JWT_SECRET` e as demais variáveis de `.env.example` conforme o ambiente.
3. No frontend, configure a URL do backend conforme o README do projeto e execute `npm start`. Use localhost ou HTTPS para permitir o microfone. Reabra a página depois da atualização do aplicativo.
4. Cadastre o roteiro abaixo em três tópicos. Crie as âncoras “12 bilhões” e “Helena Duarte” como essenciais e “nosso site” como chamada final.
5. Ative Auto e, se desejar, Começar pela voz. Confirme a indicação de reconhecimento de voz; uma execução em Auto por tempo não valida este teste.

## Roteiro da demonstração

**Abertura**
Boa noite. O Governo Federal anunciou hoje um pacote de doze bilhões para quinze estados brasileiros a partir de janeiro. A proposta prevê melhorias na infraestrutura e novas oportunidades para a população.

**Detalhes**
A ministra Helena Duarte afirmou que as obras começam pelo Nordeste. A primeira etapa inclui a recuperação das rodovias e a ampliação dos serviços públicos. O calendário será divulgado após a reunião com os representantes dos estados.

**Encerramento**
Você pode acompanhar tudo no nosso site. A equipe vai atualizar as informações durante a semana. Obrigado pela companhia e boa noite.

## Seis leituras obrigatórias — execução manual pendente

| Reconhecimento | Ritmo aproximado | Resultado |
|---|---:|---|
| Deepgram | 90 palavras/min | Pendente |
| Deepgram | 150 palavras/min | Pendente |
| Deepgram | 220 palavras/min | Pendente |
| Navegador | 90 palavras/min | Pendente |
| Navegador | 150 palavras/min | Pendente |
| Navegador | 220 palavras/min | Pendente |

Para Deepgram, configure `DEEPGRAM_API_KEY` no backend e reinicie o servidor. Confira a conexão com a Deepgram nos eventos de voz. Para usar só o reconhecimento do navegador, esvazie essa variável, reinicie o backend e recarregue o frontend. Mantenha o backend conectado: “sem Deepgram” não exige desconectar o servidor. Alguns navegadores usam um serviço remoto de reconhecimento e podem exigir internet.

Em cada leitura, volte ao início antes de começar e faça estes desvios:

1. Gagueje: “o governo, o governo federal anunciou”. A posição não deve recuar nem disparar adiante.
2. Troque “anunciou hoje” por “divulgou nesta manhã”. Retome o texto; a posição deve reencontrar o trecho seguinte.
3. Omita a última frase do tópico Detalhes e siga para Encerramento. A rolagem deve alcançar o trecho retomado sem voltar ao início do tópico.
4. Faça uma pausa de três segundos. O texto deve parar de avançar ao alcançar a posição reconhecida e voltar a acompanhar após a retomada.
5. Em uma execução adicional, pule a frase que contém Helena Duarte. A âncora deve continuar pendente e aparecer entre as que ficaram para trás.
6. Improvise por cinco segundos e retome “Você pode acompanhar tudo no nosso site”. Verifique improviso, recuperação e marcação final da chamada.

Registre por execução: navegador e versão, microfone, motor usado, ritmo, atraso percebido, recuos indevidos, âncoras incorretas e falhas de retomada. Se possível, grave a tela e o áudio juntos para comparar a fala com a linha.

## Demonstração na mentoria — cerca de três minutos

1. Mostre Auto e o motor de voz em uso.
2. Leia a abertura em ritmo natural e repita uma expressão.
3. Troque uma palavra e pule uma frase em Detalhes.
4. Faça a pausa, retome e mostre a chamada final marcada.
5. Mostre a tabela das seis leituras preenchida com os resultados reais e relate qualquer atraso observado.

## Validação automatizada realizada

- Backend: 42 testes aprovados, incluindo WebSocket com Deepgram simulada, fluxo do navegador, parciais, repetição, autocorreção, frase pulada, improviso e ritmo a 90/150/220 ppm.
- Frontend: 40 testes aprovados, incluindo localização tolerante e simulação de rolagem nas três velocidades.
- Estes testes não usam microfone nem uma conta real da Deepgram. A aparência da rolagem e as seis leituras em voz alta ainda precisam de validação manual.

## Entrega

Use as alterações do backend e do frontend em conjunto. Consulte o histórico de cada repositório para identificar os commits desta melhoria.
