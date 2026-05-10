using System.Net.Http;
using System.Text;
using System.Text.Json;

public sealed class MamishiAIClient
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly HttpClient _client;

    public MamishiAIClient(
        string apiKey,
        string baseUrl = "http://localhost:5001",
        HttpClient? httpClient = null)
    {
        _client = httpClient ?? new HttpClient();
        _client.BaseAddress = new Uri(baseUrl.TrimEnd('/'));

        if (!_client.DefaultRequestHeaders.Contains("x-api-key"))
        {
            _client.DefaultRequestHeaders.Add("x-api-key", apiKey);
        }
    }

    public async Task<string> AskAsync(string question, string context = "", CancellationToken cancellationToken = default)
    {
        var payload = new AskRequest(question, context);
        var response = await PostAsync<AskResponse>("/api/ask", payload, cancellationToken);
        return response.Answer ?? string.Empty;
    }

    public async Task<string> ChatAsync(IReadOnlyList<MamishiChatMessage> messages, CancellationToken cancellationToken = default)
    {
        var payload = new ChatRequest(messages);
        var response = await PostAsync<ChatResponse>("/api/chat", payload, cancellationToken);
        return response.Answer
            ?? response.Message?.Content
            ?? string.Empty;
    }

    public async Task<bool> IsHealthyAsync(CancellationToken cancellationToken = default)
    {
        using var response = await _client.GetAsync("/api/health", cancellationToken);
        return response.IsSuccessStatusCode;
    }

    private async Task<T> PostAsync<T>(string path, object payload, CancellationToken cancellationToken)
    {
        var body = JsonSerializer.Serialize(payload, JsonOptions);
        using var content = new StringContent(body, Encoding.UTF8, "application/json");
        using var response = await _client.PostAsync(path, content, cancellationToken);
        var json = await response.Content.ReadAsStringAsync(cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            throw new HttpRequestException($"Mamishi API request failed: {(int)response.StatusCode} {json}");
        }

        var result = JsonSerializer.Deserialize<T>(json, JsonOptions);
        if (result is null)
        {
            throw new InvalidOperationException("Mamishi API returned an empty response.");
        }

        return result;
    }
}

public sealed record MamishiChatMessage(string Role, string Content);

internal sealed record AskRequest(string Question, string Context);

internal sealed record ChatRequest(IReadOnlyList<MamishiChatMessage> Messages);

internal sealed record AskResponse(string? Question, string? Context, string? Answer, string? Backend);

internal sealed record ChatResponse(string? Answer, ChatMessageEnvelope? Message, string? Backend, int Message_Count);

internal sealed record ChatMessageEnvelope(string? Role, string? Content);

/*
Usage:

var ai = new MamishiAIClient("mamishi-dev-key");

var answer = await ai.AskAsync(
    "Generate a management letter point for revenue risk",
    "Client: SADTU Eastern Cape");

var reply = await ai.ChatAsync(new[]
{
    new MamishiChatMessage("user", "What is a going concern?"),
    new MamishiChatMessage("assistant", "A going concern means..."),
    new MamishiChatMessage("user", "How do I document it in a working paper?")
});
*/
