# TCI Sim – Simulador de infusão TCI

*powered by anestec* · TCI manual para bombas em ml/h

Aplicativo web (HTML + JavaScript puro, funciona offline) que simula a **infusão alvo-controlada (TCI)**
e converte o alvo desejado (Cp ou Ce) em um **esquema executável em bombas comuns**: bolus em ml e
taxas em ml/h com horário de cada ajuste. Serve para apoiar a tomada de decisão em hospitais sem bombas TCI.

> ⚠️ Ferramenta educacional/apoio à decisão. As concentrações são previsões populacionais dos modelos.
> Confira doses, diluições e programação da bomba e monitore o paciente clinicamente.

## Como usar

1. Abra `index.html` no navegador (ou publique a pasta no GitHub Pages). Não precisa de servidor nem internet.
2. Preencha os dados do paciente. O bolus é considerado manual (instantâneo), as taxas são arredondadas a 0,1 ml/h, os ajustes ocorrem no mínimo a cada 2 min e a duração simulada se estende automaticamente (≥ 4 h e 2 h além da última ação, até 12 h).
3. Em cada infusão escolha fármaco, modelo e concentração da seringa.
4. Escolha a ação (alvo no efeito, alvo plasmático, taxa manual, bolus ou parar), o valor e clique **Aplicar** –
   a ação entra no **tempo atual** da linha do tempo.
5. Use os controles de tempo (▶, ±10 s, ±1 min, ±10 min, barra deslizante ou clique no gráfico) para avançar/retroceder.
   O painel mostra a taxa que deve estar na bomba naquele instante, Cp, Ce, volume infundido e o próximo ajuste.
6. **Várias infusões simultâneas**: “+ Adicionar infusão” (ex.: propofol + remifentanil + dexmedetomidina),
   todas compartilham o mesmo paciente e o mesmo relógio.

O gráfico mostra 30 minutos por padrão e acompanha o tempo atual; use **+** e **−** no canto do gráfico para ver de 10 min até a simulação inteira.

O estado fica salvo no navegador (localStorage). Atalhos: espaço = reproduzir/pausar, ← / → = ±1 min (Shift = ±10 min).

## Instalar no celular (PWA)

O app é um PWA: depois de publicado (GitHub Pages) pode ser instalado e funciona **sem internet**.

- **Android (Chrome)**: abra o link → menu ⋮ → **Instalar app** (ou "Adicionar à tela inicial").
- **iPhone/iPad (Safari)**: abra o link → botão **Compartilhar** → **Adicionar à Tela de Início**.

Ao publicar uma nova versão, altere `CACHE` em `sw.js` e o `?v=` dos arquivos em `index.html`; os aparelhos instalados baixam a atualização e recarregam sozinhos ao abrir o app.

## Uso por várias pessoas

- Publicado no GitHub Pages, qualquer número de pessoas pode abrir o app ao mesmo tempo; cada aparelho tem a sua
  própria simulação independente (nada é enviado a servidor).
- **Compartilhar** (botão no topo) copia um link com o cenário inteiro (paciente, bomba, infusões e ações) codificado
  no próprio endereço. Quem abrir o link vê exatamente o mesmo cenário e pode continuar a partir dele.

## Fármacos e modelos

| Fármaco | Modelos |
|---|---|
| Propofol | Eleveld (padrão), Marsh, Schnider, Paedfusor |
| Remifentanil | Minto, Eleveld |
| Fentanil | Shafer |
| Alfentanil | Maitre |
| Dexmedetomidina | Hannivoort, Dyck |
| Cetamina | Kamp, Domino |

Os parâmetros e covariáveis (massa magra de James, massa livre de gordura de Al-Sallami, maturação/envelhecimento
de Eleveld, ke0 de cada modelo) foram obtidos por engenharia reversa do código público do
[SimTIVA](https://simtiva.app) (`pharmacology.js`) e conferidos com as publicações originais.

## Fórmulas

**Modelo**: três compartimentos + compartimento efeito. As constantes (min⁻¹) são convertidas para s⁻¹ e
λ₁..₃ são as raízes da cúbica característica (`cube.c` do STANPUMP):

```
a0 = k10·k21·k31
a1 = k10·k31 + k21·k31 + k21·k13 + k10·k21 + k31·k12
a2 = k10 + k12 + k13 + k21 + k31
λ³ − a2·λ² + a1·λ − a0 = 0
```

Coeficientes da resposta a uma infusão unitária (1 unidade/s):

```
A_i  = (k21−λi)(k31−λi) / [(λi−λj)(λi−λk)] / V1 / λi              (plasma, i=1..3)
Ae_i = A_i · ke0 / (ke0 − λi)                                       (efeito, i=1..3)
Ae_4 = (ke0−k21)(ke0−k31) / [(λ1−ke0)(λ2−ke0)(λ3−ke0)] / V1         (efeito, λ4 = ke0)
```

Atualização exata a cada segundo com taxa constante I:

```
Cp_i(t+1) = Cp_i(t)·e^(−λi) + A_i·I·(1 − e^(−λi))     Cp = Σ Cp_i
Ce_i(t+1) = Ce_i(t)·e^(−λi) + Ae_i·I·(1 − e^(−λi))    Ce = Σ Ce_i
```

**Alvo plasmático**: bolus = (alvo − Cp prevista em 1 s sem infusão) / Cp_udf(1 s). Em seguida, a cada 120 s,
taxa ideal = (alvo − Cp livre em 120 s) / Cp_udf(120 s). Para a bomba manual as taxas ideais viram degraus: a taxa
só muda quando a ideal se afasta mais que a tolerância (8% propofol/opioides, 15% dex/cetamina/alfentanil), e o valor
do degrau é `(ideal_início − ideal_fim)·f + ideal_fim` (f ≈ 0,52–0,75). A cada degrau o cálculo é refeito a partir do
estado real previsto (malha fechada), já com a taxa arredondada para a resolução de 0,1 ml/h.

**Alvo no efeito**: bolus encontrado por busca binária para que o pico de Ce
seja igual ao alvo; pausa até o pico; depois manutenção como no alvo plasmático. Ao reduzir o alvo, pausa entre o
tempo para Cp e o tempo para Ce caírem ao alvo (fator sigmoide do SimTIVA) e então retomada.

## Testes

```
node tests/validate_ode.js   # compara a solução analítica com integração numérica RK4 (todos os modelos)
node tests/smoke.js          # imprime esquemas de exemplo
```

## Estrutura

- `index.html`, `css/style.css` – interface
- `js/pk.js` – modelos e motor farmacocinético
- `js/tci.js` – geração dos esquemas (bolus/ml/h) e simulação
- `js/app.js` – interface, gráficos (Chart.js) e linha do tempo
- `vendor/chart.umd.min.js` – Chart.js 4.4.4 (MIT), incluído para uso offline
- `brand/logo-mark.svg`, `icons/` – marca TCI Sim / anestec e ícones do aplicativo
- `fonts/` – Montserrat (títulos) e Inter (textos), SIL Open Font License, incluídas para uso offline
