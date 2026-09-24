----------------------------------------------------------------------------------------------------
-- Module Initialization
----------------------------------------------------------------------------------------------------

function Init()
	local m = NewWebsiteModule()
	m.ID                       = '997d516552414f7484cdd961f9cf48ec'
	m.Name                     = 'LeerManhwas'
	m.RootURL                  = 'https://leermanhwas.com'
	m.Category                 = 'Spanish'
	m.OnGetDirectoryPageNumber = 'GetDirectoryPageNumber'
	m.OnGetNameAndLink         = 'GetNameAndLink'
	m.OnGetInfo                = 'GetInfo'
	m.OnGetPageNumber          = 'GetPageNumber'
	m.OnBeforeDownloadImage    = 'BeforeDownloadImage'
	m.SortedList               = true
end

----------------------------------------------------------------------------------------------------
-- Event Functions
----------------------------------------------------------------------------------------------------

-- A page past the end is clamped to the last one, whose pager marks it active.
function GetDirectoryPageNumber()
	if not HTTP.GET(MODULE.RootURL .. '/page/9999/') then return net_problem end

	PAGENUMBER = tonumber(CreateTXQuery(HTTP.Document).XPathString('//div[@id="pagination"]//li[contains(@class, "active")]/a/@href'):match('/page/(%d+)/')) or 1

	return no_error
end

-- Get links and names from the manga list of the current website.
function GetNameAndLink()
	local u = MODULE.RootURL .. '/page/' .. (URL + 1) .. '/'

	if not HTTP.GET(u) then return net_problem end

	local x = CreateTXQuery(HTTP.Document)
	for v in x.XPath('//div[@class="mm-name"]/a').Get() do
		LINKS.Add(v.GetAttribute('href'))
		NAMES.Add(x.XPathString('normalize-space(h3)', v))
	end

	return no_error
end

-- Get info and chapter list for the current manga.
function GetInfo()
	local u = MaybeFillHost(MODULE.RootURL, URL)

	if not HTTP.GET(u) then return net_problem end

	local x = CreateTXQuery(HTTP.Document)
	MANGAINFO.Title     = x.XPathString('normalize-space(//h1[contains(@class, "main-info-title")])')
	MANGAINFO.AltTitles = x.XPathString('normalize-space(//div[contains(@class, "main-info-right")]//h4)')
	MANGAINFO.CoverLink = x.XPathString('//img[@class="img-cover"]/@src')
	MANGAINFO.Authors   = x.XPathStringAll('//li[h5[contains(., "Autores")]]/div/a')
	MANGAINFO.Artists   = x.XPathStringAll('//li[h5[contains(., "Artistas")]]/div/a')
	MANGAINFO.Genres    = x.XPathStringAll('//li[h5[contains(., "Géneros")]]/div/a')
	MANGAINFO.Status    = MangaInfoStatusIfPos(x.XPathString('//div[contains(@class, "post-status")]//li[h5[contains(., "Estado")]]/span'), 'Ongoing|En curso', 'Completed|Completado|Finalizado')
	MANGAINFO.Summary   = x.XPathString('string-join(//div[@class="short-desc-content"]/p, "\r\n")')

	for v in x.XPath('//ul[@class="chapter-list"]/li/a').Get() do
		MANGAINFO.ChapterLinks.Add(v.GetAttribute('href'))
		MANGAINFO.ChapterNames.Add(x.XPathString('normalize-space(.//span[@class="chapter-name"])', v))
	end
	MANGAINFO.ChapterLinks.Reverse(); MANGAINFO.ChapterNames.Reverse()

	return no_error
end

-- Get the page count and/or page links for the current chapter.
function GetPageNumber()
	local u = MaybeFillHost(MODULE.RootURL, URL)

	if not HTTP.GET(u) then return false end

	CreateTXQuery(HTTP.Document).XPathStringAll('//div[contains(@class, "reading-content")]//img[contains(@class, "loading")]/@src', TASK.PageLinks)

	return true
end

-- Prepare the URL, http header and/or http cookies before downloading an image.
function BeforeDownloadImage()
	HTTP.Headers.Values['Referer'] = MODULE.RootURL .. '/'

	return true
end
