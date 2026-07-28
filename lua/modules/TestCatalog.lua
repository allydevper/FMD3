----------------------------------------------------------------------------------------------------
-- TestCatalog — LOCAL DEV MOCK ONLY (http://localhost:1420/__test_catalog)
-- Does not hit real websites. Requires `tauri dev` (Vite middleware).
--
-- How to test (catalog):
--   1. Run tauri dev (Vite :1420 serves the mock).
--   2. Ajustes → Sitios Web → enable "TestCatalog".
--   3. Catálogo → Actualizar lista (one site).
--   4. Page 1 lists 10 downloadable titles first (dl-*, mixed name lengths).
--
-- How to test (downloads):
--   1. Open a dl-* title (or Descargar todo from context menu).
--   2. Chapters use images from .plan/caps/{1..8} via /__test_catalog/caps/...
--   3. Pause / resume / clear finished in Descargas.
--
-- Reset catalog DB: delete %%AppData%%/fmd-mvp/data/ffffffffffffffffffffffffffffffff.db
-- Browser: http://localhost:1420/__test_catalog/directorio?p=1
----------------------------------------------------------------------------------------------------

function Init()
	local m = NewWebsiteModule()
	m.ID                       = 'ffffffffffffffffffffffffffffffff'
	m.Name                     = 'TestCatalog'
	m.RootURL                  = 'http://localhost:1420/__test_catalog'
	m.Category                 = 'Test'
	m.SortedList               = true
	m.OnGetDirectoryPageNumber = 'GetDirectoryPageNumber'
	m.OnGetNameAndLink         = 'GetNameAndLink'
	m.OnGetInfo                = 'GetInfo'
	m.OnGetPageNumber          = 'GetPageNumber'
end

-- RootURL must be `localhost` (not 127.0.0.1) when Vite binds to the hostname only.

----------------------------------------------------------------------------------------------------
-- Local Constants
----------------------------------------------------------------------------------------------------

DirectoryPagination = '/directorio?p='

----------------------------------------------------------------------------------------------------
-- Event Functions
----------------------------------------------------------------------------------------------------

function GetDirectoryPageNumber()
	local u = MODULE.RootURL .. DirectoryPagination .. 1

	if not HTTP.GET(u) then return net_problem end

	PAGENUMBER = tonumber(CreateTXQuery(HTTP.Document).XPathString('//ul[@class="pagination"]/li[last()-1]/a')) or 1

	return no_error
end

function GetNameAndLink()
	local v, x = nil
	local u = MODULE.RootURL .. DirectoryPagination .. (URL + 1)

	if not HTTP.GET(u) then return net_problem end

	x = CreateTXQuery(HTTP.Document)
	for v in x.XPath('//div[@id="article-div"]//a').Get() do
		LINKS.Add(v.GetAttribute('href'))
		NAMES.Add(x.XPathString('span', v))
	end

	return no_error
end

function GetInfo()
	local v, x, link, name, n = nil
	local u = MaybeFillHost(MODULE.RootURL, URL)

	if not HTTP.GET(u) then return net_problem end

	x = CreateTXQuery(HTTP.Document)
	MANGAINFO.Title     = x.XPathString('//h1[@class="post-title"]/a')
	MANGAINFO.Authors   = x.XPathString('//div[@id="info-i"]/strong[.="Autor:"]/following-sibling::text()[1]')
	MANGAINFO.Genres    = x.XPathStringAll('//div[@id="categ"]/a')
	MANGAINFO.Status    = MangaInfoStatusIfPos(x.XPathString('//span[@class="estado"]'), 'En desarrollo', 'Finalizado')
	MANGAINFO.Summary   = x.XPathString('//div[@id="sinopsis"]')

	for v in x.XPath('//div[@id="c_list"]/a').Get() do
		link = v.GetAttribute('href')
		name = x.XPathString('div/h3', v)
		if name == nil or name == '' then
			n = link:match('ch%-(%d+)')
			name = n and ('Capítulo ' .. n) or link
		end
		MANGAINFO.ChapterLinks.Add(link)
		MANGAINFO.ChapterNames.Add(name)
	end
	MANGAINFO.ChapterLinks.Reverse(); MANGAINFO.ChapterNames.Reverse()

	return no_error
end

function GetPageNumber()
	local u, x, v, src = nil
	u = MaybeFillHost(MODULE.RootURL, URL)

	if not HTTP.GET(u) then return net_problem end

	x = CreateTXQuery(HTTP.Document)
	-- Prefer element attrs (more reliable than //@src string-all in some builds).
	for v in x.XPath('//div[@id="reader"]//img').Get() do
		src = v.GetAttribute('src')
		if src ~= nil and src ~= '' then
			TASK.PageLinks.Add(src)
		end
	end
	if TASK.PageLinks.Count == 0 then
		for v in x.XPath('//div[@id="reader"]//a[@class="page"]').Get() do
			src = v.GetAttribute('href')
			if src ~= nil and src ~= '' then
				TASK.PageLinks.Add(src)
			end
		end
	end
	if TASK.PageLinks.Count == 0 then
		return net_problem
	end

	return no_error
end
