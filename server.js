require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2");

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const db = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    rejectUnauthorized: false,
  },
});

db.connect((err) => {
  if (err) {
    console.log("Erro ao conectar:", err);
    return;
  }
  console.log("✅ Conectado ao MySQL!");
});

app.get("/", (req, res) => {
  res.send("Backend funcionando!");
});

function normalizarTexto(texto) {
  return String(texto || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function lerEstoqueVariacoes(valor) {
  if (!valor) return [];

  try {
    const convertido = JSON.parse(valor);

    if (Array.isArray(convertido)) {
      return convertido.map((item) => ({
        tamanho: item.tamanho || "",
        cor: item.cor || "",
        quantidade: Number(item.quantidade || 0),
      }));
    }

    if (typeof convertido === "object") {
      return Object.entries(convertido).map(([chave, quantidade]) => {
        const partes = chave.split("|");

        return {
          tamanho: partes[0] || "",
          cor: partes[1] || "",
          quantidade: Number(quantidade || 0),
        };
      });
    }
  } catch (error) {
    return String(valor)
      .split("\n")
      .map((linha) => linha.trim())
      .filter((linha) => linha !== "")
      .map((linha) => {
        const partes = linha.split(",");

        return {
          tamanho: partes[0]?.trim() || "",
          cor: partes[1]?.trim() || "",
          quantidade: Number(partes[2]?.trim() || 0),
        };
      });
  }

  return [];
}

function salvarEstoqueVariacoes(estoque) {
  return JSON.stringify(estoque);
}

// PRODUTOS
app.get("/produtos", (req, res) => {
  db.query("SELECT * FROM produtos", (err, result) => {
    if (err) return res.status(500).json(err);
    res.json(result);
  });
});

app.post("/produtos", (req, res) => {
  const {
    nome,
    descricao,
    preco,
    imagem,
    tamanhos,
    cores,
    estoque_variacoes,
  } = req.body;

  db.query(
    `INSERT INTO produtos 
    (nome, descricao, preco, imagem, tamanhos, cores, estoque_variacoes) 
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [nome, descricao, preco, imagem, tamanhos, cores, estoque_variacoes],
    (err, result) => {
      if (err) return res.status(500).json(err);

      res.json({
        id: result.insertId,
        nome,
        descricao,
        preco,
        imagem,
        tamanhos,
        cores,
        estoque_variacoes,
      });
    }
  );
});

app.put("/produtos/:id", (req, res) => {
  const { id } = req.params;
  const {
    nome,
    descricao,
    preco,
    imagem,
    tamanhos,
    cores,
    estoque_variacoes,
  } = req.body;

  db.query(
    `UPDATE produtos 
    SET nome = ?, descricao = ?, preco = ?, imagem = ?, tamanhos = ?, cores = ?, estoque_variacoes = ? 
    WHERE id = ?`,
    [nome, descricao, preco, imagem, tamanhos, cores, estoque_variacoes, id],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ message: "Produto atualizado com sucesso!" });
    }
  );
});

app.delete("/produtos/:id", (req, res) => {
  const { id } = req.params;

  db.query("DELETE FROM produtos WHERE id = ?", [id], (err) => {
    if (err) return res.status(500).json(err);
    res.json({ message: "Produto excluído com sucesso!" });
  });
});

// PEDIDOS
app.post("/pedidos", (req, res) => {
  const {
    itens,
    total,
    cliente_nome,
    cliente_telefone,
    cliente_email,
    endereco,
    forma_pagamento,
  } = req.body;

  if (!itens || itens.length === 0) {
    return res.status(400).json({ message: "Carrinho vazio" });
  }

  db.beginTransaction((err) => {
    if (err) return res.status(500).json(err);

    const idsProdutos = [...new Set(itens.map((item) => item.id))];

    db.query(
      "SELECT * FROM produtos WHERE id IN (?) FOR UPDATE",
      [idsProdutos],
      (err, produtosBanco) => {
        if (err) {
          return db.rollback(() => res.status(500).json(err));
        }

        for (const item of itens) {
          const produtoBanco = produtosBanco.find(
            (produto) => Number(produto.id) === Number(item.id)
          );

          if (!produtoBanco) {
            return db.rollback(() =>
              res.status(404).json({
                message: `Produto ${item.nome} não encontrado.`,
              })
            );
          }

          if (item.tamanho && item.cor) {
            const estoque = lerEstoqueVariacoes(
              produtoBanco.estoque_variacoes
            );

            const variacao = estoque.find(
              (variacao) =>
                normalizarTexto(variacao.tamanho) ===
                  normalizarTexto(item.tamanho) &&
                normalizarTexto(variacao.cor) === normalizarTexto(item.cor)
            );

            if (!variacao || Number(variacao.quantidade) < Number(item.quantidade)) {
              return db.rollback(() =>
                res.status(400).json({
                  message: `Estoque insuficiente para ${item.nome} - ${item.tamanho} / ${item.cor}.`,
                })
              );
            }

            variacao.quantidade =
              Number(variacao.quantidade) - Number(item.quantidade);

            produtoBanco.estoque_variacoes = salvarEstoqueVariacoes(estoque);
          }
        }

        const atualizarEstoques = produtosBanco.map((produto) => {
          return new Promise((resolve, reject) => {
            db.query(
              "UPDATE produtos SET estoque_variacoes = ? WHERE id = ?",
              [produto.estoque_variacoes, produto.id],
              (err) => {
                if (err) reject(err);
                else resolve();
              }
            );
          });
        });

        Promise.all(atualizarEstoques)
          .then(() => {
            db.query(
              `INSERT INTO pedidos 
              (total, status, cliente_nome, cliente_telefone, cliente_email, endereco, forma_pagamento) 
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                total,
                "Novo pedido",
                cliente_nome || null,
                cliente_telefone || null,
                cliente_email || null,
                endereco || null,
                forma_pagamento || null,
              ],
              (err, result) => {
                if (err) {
                  return db.rollback(() => res.status(500).json(err));
                }

                const pedidoId = result.insertId;

                const itensFormatados = itens.map((item) => [
                  pedidoId,
                  item.id,
                  item.nome,
                  item.preco,
                  item.quantidade,
                  Number(item.preco) * item.quantidade,
                  item.imagem,
                  item.tamanho || null,
                  item.cor || null,
                ]);

                db.query(
                  `INSERT INTO pedido_itens 
                  (pedido_id, produto_id, nome, preco, quantidade, subtotal, imagem, tamanho, cor) 
                  VALUES ?`,
                  [itensFormatados],
                  (err) => {
                    if (err) {
                      return db.rollback(() => res.status(500).json(err));
                    }

                    db.commit((err) => {
                      if (err) {
                        return db.rollback(() => res.status(500).json(err));
                      }

                      res.json({
                        message: "Pedido salvo com sucesso!",
                        pedidoId,
                      });
                    });
                  }
                );
              }
            );
          })
          .catch((error) => {
            db.rollback(() => res.status(500).json(error));
          });
      }
    );
  });
});

app.get("/pedidos", (req, res) => {
  db.query("SELECT * FROM pedidos ORDER BY data_pedido DESC", (err, result) => {
    if (err) return res.status(500).json(err);
    res.json(result);
  });
});

app.get("/acompanhar-pedido", (req, res) => {
  const { pedidoId, telefone } = req.query;

  if (!pedidoId || !telefone) {
    return res.status(400).json({ message: "Informe pedido e telefone." });
  }

  db.query(
    "SELECT * FROM pedidos WHERE id = ? AND cliente_telefone = ?",
    [pedidoId, telefone],
    (err, result) => {
      if (err) return res.status(500).json(err);

      if (result.length === 0) {
        return res.status(404).json({ message: "Pedido não encontrado." });
      }

      res.json(result[0]);
    }
  );
});

app.get("/pedidos/:id/itens", (req, res) => {
  const { id } = req.params;

  db.query(
    "SELECT * FROM pedido_itens WHERE pedido_id = ?",
    [id],
    (err, result) => {
      if (err) return res.status(500).json(err);
      res.json(result);
    }
  );
});

app.put("/pedidos/:id/status", (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  db.query(
    "UPDATE pedidos SET status = ? WHERE id = ?",
    [status, id],
    (err) => {
      if (err) return res.status(500).json(err);
      res.json({ message: "Status atualizado com sucesso!" });
    }
  );
});

app.delete("/pedidos/:id", (req, res) => {
  const { id } = req.params;

  db.query("DELETE FROM pedido_itens WHERE pedido_id = ?", [id], (err) => {
    if (err) return res.status(500).json(err);

    db.query("DELETE FROM pedidos WHERE id = ?", [id], (err) => {
      if (err) return res.status(500).json(err);

      res.json({ message: "Pedido excluído com sucesso!" });
    });
  });
});

app.listen(process.env.PORT, () => {
  console.log("🚀 Servidor rodando na porta 3001");
});