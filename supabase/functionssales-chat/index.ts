import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Tool definitions for AI function calling
const tools = [
  {
    type: "function",
    function: {
      name: "query_mongodb_sales",
      description:
        "Query the MongoDB sales collection. Use this for sales count, sales by date, sales by product, etc.",
      parameters: {
        type: "object",
        properties: {
          query_type: {
            type: "string",
            enum: ["count", "find", "aggregate"],
            description: "Type of MongoDB query",
          },
          filters: {
            type: "object",
            description: "MongoDB filter criteria (e.g., date ranges, productId)",
          },
        },
        required: ["query_type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_mongodb_products",
      description:
        "Query the MongoDB products collection. Use this for product prices, stock levels, categories, etc.",
      parameters: {
        type: "object",
        properties: {
          product_identifier: {
            type: "string",
            description: "Product ID or name to search for",
          },
          field: {
            type: "string",
            description: "Specific field to retrieve (price, stock, category)",
          },
        },
        required: ["product_identifier"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_json_product_details",
      description:
        "Retrieve detailed product information from local JSON files (description, manufacturer, warranty).",
      parameters: {
        type: "object",
        properties: {
          product_sku: {
            type: "string",
            description: "Product SKU to look up",
          },
        },
        required: ["product_sku"],
      },
    },
  },
];

// Mock MongoDB query execution (replace with actual MongoDB connection)
function executeMongoDB(toolCall: any) {
  const args = JSON.parse(toolCall.function.arguments);
  console.log("Executing MongoDB query:", args);

  // Example mock data
  if (toolCall.function.name === "query_mongodb_sales") {
    if (args.query_type === "count") {
      return { count: 42, period: "yesterday" };
    }
    return {
      sales: [
        {
          productId: "SKU123",
          productName: "SuperWidget",
          quantity: 2,
          totalPrice: 199.98,
          saleDate: "2025-11-16T10:30:00Z",
        },
      ],
    };
  }

  if (toolCall.function.name === "query_mongodb_products") {
    return {
      _id: "SKU123",
      name: "SuperWidget",
      price: 99.99,
      category: "Widgets",
      stock: 450,
    };
  }

  return { error: "Query not implemented" };
}

// Query JSON file for product details
async function queryProductDetails(productSku: string) {
  try {
    const response = await fetch(
      new URL("../../../public/data/product_details.json", import.meta.url)
    );
    const data = await response.json();
    return data[productSku] || { error: "Product not found" };
  } catch (error) {
    console.error("Error reading product details:", error);
    return { error: "Failed to read product details" };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { messages } = await req.json();
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

    if (!LOVABLE_API_KEY) {
      throw new Error("LOVABLE_API_KEY is not configured");
    }

    console.log("Received messages:", messages.length);

    // Initial AI call with tools
    const aiResponse = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "system",
              content:
                "You are an AI sales analyst assistant. You have access to sales data in MongoDB and product details in JSON files. Use the provided tools to query the data and provide helpful insights. Always be clear and concise in your responses. When you receive data from a tool, format it nicely for the user.",
            },
            ...messages,
          ],
          tools: tools,
          tool_choice: "auto",
        }),
      }
    );

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();
      console.error("AI gateway error:", aiResponse.status, errorText);
      
      if (aiResponse.status === 429) {
        return new Response(
          JSON.stringify({ error: "Rate limit exceeded" }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      if (aiResponse.status === 402) {
        return new Response(
          JSON.stringify({ error: "Payment required" }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      throw new Error(`AI gateway error: ${aiResponse.status}`);
    }

    const aiData = await aiResponse.json();
    console.log("AI response:", JSON.stringify(aiData, null, 2));

    const choice = aiData.choices[0];
    const toolCalls = choice.message.tool_calls;

    // If no tool calls, return the direct response
    if (!toolCalls || toolCalls.length === 0) {
      return new Response(
        JSON.stringify({ response: choice.message.content }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Execute tool calls
    const toolResults = [];
    for (const toolCall of toolCalls) {
      console.log("Executing tool:", toolCall.function.name);

      let result;
      if (toolCall.function.name === "query_json_product_details") {
        const args = JSON.parse(toolCall.function.arguments);
        result = await queryProductDetails(args.product_sku);
      } else {
        result = executeMongoDB(toolCall);
      }

      toolResults.push({
        tool_call_id: toolCall.id,
        role: "tool",
        name: toolCall.function.name,
        content: JSON.stringify(result),
      });
    }

    // Send tool results back to AI for final response
    const finalResponse = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            {
              role: "system",
              content:
                "You are an AI sales analyst assistant. You have access to sales data in MongoDB and product details in JSON files. Use the provided tools to query the data and provide helpful insights. Always be clear and concise in your responses. When you receive data from a tool, format it nicely for the user.",
            },
            ...messages,
            choice.message,
            ...toolResults,
          ],
        }),
      }
    );

    if (!finalResponse.ok) {
      throw new Error(`Final AI call failed: ${finalResponse.status}`);
    }

    const finalData = await finalResponse.json();
    const finalContent = finalData.choices[0].message.content;

    return new Response(
      JSON.stringify({ response: finalContent }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error in sales-chat:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
